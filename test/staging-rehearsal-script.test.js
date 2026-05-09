import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const expectedReceiptVisibilityKeys = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
];
const expectedProductionSignoffConditionKeys = [
  "full_test_window_passed",
  "staging_artifacts_archived",
  "launch_mainline_receipts_visible",
  "launch_ops_overview_status_visible",
  "backup_restore_drill_passed",
  "rollback_path_confirmed",
  "operator_signoff_recorded"
];
const expectedCloseoutEvidence = {
  route_map_gate_result: {
    sourceStep: "run_route_map_gate",
    expectedEvidence: "Record the targeted gate exit status, pass count, and redacted output artifact path."
  },
  backup_restore_drill_result: {
    sourceStep: "run_backup_restore_drill",
    expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
  },
  live_write_smoke_result: {
    sourceStep: "run_live_write_smoke",
    expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
  },
  launch_smoke_handoff: {
    sourceStep: "archive_launch_smoke_handoff",
    expectedEvidence: "Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted."
  },
  launch_mainline_evidence_receipts: {
    sourceStep: "record_launch_mainline_evidence",
    expectedEvidence: "Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action."
  },
  receipt_visibility_review: {
    sourceStep: "verify_receipt_visibility",
    expectedEvidence: "Verify Launch Review, Launch Smoke, and Launch Ops Overview Status receipt-visibility summaries show the recorded first-wave receipt."
  },
  operator_go_no_go: {
    sourceStep: "backfill_filled_closeout_input",
    expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
  }
};
const expectedProductionSignoffEvidence = {
  full_test_window_passed: "Attach the full `npm.cmd test` output summary and failure count.",
  staging_artifacts_archived: "Confirm the artifact/receipt ledger archive paths exist and contain redacted artifacts.",
  launch_mainline_receipts_visible: "Confirm Launch Mainline, Launch Review, Launch Smoke, and Developer Ops show the latest receipts.",
  launch_ops_overview_status_visible: "Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover.",
  backup_restore_drill_passed: "Confirm the backup and restore drill passed on the intended staging storage profile.",
  rollback_path_confirmed: "Confirm rollback walkthrough and recovery handoff are current before production cutover.",
  operator_signoff_recorded: "Record operator, timestamp, decision, and reason in the go/no-go artifact."
};
const expectedReceiptVisibilityEvidence = {
  launchMainline: "Confirm Launch Mainline receipt visibility shows the latest staging evidence receipts before cutover.",
  launchReview: "Confirm Launch Review summary download shows the latest staging evidence receipts before cutover.",
  launchSmoke: "Confirm Launch Smoke summary download shows the latest staging evidence receipts before cutover.",
  developerOps: "Confirm Developer Ops receipt visibility shows the latest staging evidence receipts before cutover.",
  launchOpsOverviewStatus: "Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover."
};

function expectedCloseoutEvidenceTargets(missingKeys = Object.keys(expectedCloseoutEvidence)) {
  return Object.entries(expectedCloseoutEvidence).map(([key, item]) => ({
    key,
    status: missingKeys.includes(key) ? "missing" : "filled",
    sourceStep: item.sourceStep,
    expectedEvidence: item.expectedEvidence
  }));
}

function expectedSignoffEvidenceTargets(missingKeys = expectedProductionSignoffConditionKeys) {
  return expectedProductionSignoffConditionKeys.map((key) => ({
    key,
    status: missingKeys.includes(key) ? "missing" : "filled",
    expectedEvidence: expectedProductionSignoffEvidence[key]
  }));
}

function expectedReceiptVisibilityEvidenceTargets(missingKeys = expectedReceiptVisibilityKeys) {
  return expectedReceiptVisibilityKeys.map((key) => ({
    key,
    status: missingKeys.includes(key) ? "missing" : "visible",
    expectedEvidence: expectedReceiptVisibilityEvidence[key]
  }));
}

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

function runRehearsalPlain(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-rehearsal.mjs", ...args], {
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
  assert.equal(output.preflights.recovery.closeoutBackfill.status, "ready_for_backup_restore_backfill");
  assert.equal(output.preflights.recovery.closeoutBackfill.key, "backup_restore_drill_result");
  assert.equal(output.preflights.recovery.closeoutBackfill.filledCloseoutInputFile, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.preflights.recovery.closeoutBackfill.readinessActionQueueFile, "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md");
  assert.equal(output.preflights.recovery.closeoutBackfill.artifactPath, "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt");
  assert.equal(
    output.preflights.recovery.closeoutBackfill.command,
    "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt --receipt-id <recovery-drill-receipt-id> --receipt-id <backup-verification-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.match(output.nextCommands.launchSmoke, /launch:smoke:staging/);
  assert.doesNotMatch(output.nextCommands.launchSmoke, /StrongAdmin123!|StrongDeveloper123!/);
  assert.match(output.nextCommands.recovery.appBackup, /backup-rocksolid\.sh/);
  assert.deepEqual(output.nextCommands.launchRouteMapGate, {
    command: "npm.cmd run launch:route-map-gate",
    dryRunCommand: "npm.cmd run launch:route-map-gate -- --dry-run --json",
    willModifyData: false,
    willRunFullSuite: false,
    purpose: "Re-run the Launch Mainline / Launch Smoke / Developer Ops route-map visibility, first-batch runtime evidence, and low-frequency download surface targeted gate before live-write staging smoke."
  });
  assert.match(output.nextCommands.launchMainline, /\/developer\/launch-mainline\?productCode=PILOT_ALPHA&channel=stable/);
  assert.deepEqual(output.nextCommands.receiptVisibilitySummaries, {
    launchReviewSummary: "https://staging.example.com/api/developer/launch-review/download?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary",
    launchSmokeSummary: "https://staging.example.com/api/developer/launch-smoke-kit/download?productCode=PILOT_ALPHA&channel=stable&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary",
    launchOpsOverviewStatus: "https://staging.example.com/api/developer/ops/export/download?productCode=PILOT_ALPHA&format=launch-operations-overview-status&limit=20"
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
  assert.equal(readinessChecks.backup_restore_drill.closeoutBackfillCommand, output.preflights.recovery.closeoutBackfill.command);
  assert.equal(readinessChecks.backup_restore_drill.statusCommand, output.preflights.recovery.closeoutBackfill.statusCommand);
  assert.equal(readinessChecks.route_map_gate.status, "operator_execute");
  assert.equal(readinessChecks.route_map_gate.label, "Route-map, first-batch runtime evidence, and download-surface gate");
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
  assert.match(output.operatorChecklist[1].label, /first-batch runtime evidence/);
  assert.match(output.operatorChecklist[1].command, /launch:route-map-gate/);
  assert.equal(output.operatorChecklist[2].closeoutBackfillCommand, output.preflights.recovery.closeoutBackfill.command);
  assert.equal(output.operatorChecklist[2].statusCommand, output.preflights.recovery.closeoutBackfill.statusCommand);
  assert.match(output.operatorChecklist[4].command, /launch:smoke:staging/);
  assert.equal(output.operatorChecklist[7].endpoint, "https://staging.example.com/api/developer/launch-mainline/action");
  assert.deepEqual(output.operatorChecklist[7].evidenceOperations.slice(0, 3), [
    "record_launch_rehearsal_run",
    "record_recovery_drill",
    "record_backup_verification"
  ]);
  assert.equal(
    output.operatorChecklist[8].downloads.launchOpsOverviewStatus,
    "https://staging.example.com/api/developer/ops/export/download?productCode=PILOT_ALPHA&format=launch-operations-overview-status&limit=20"
  );
  assert.doesNotMatch(JSON.stringify(output.operatorChecklist), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.operatorExecutionPlan.status, "ready_for_staging_execution");
  assert.equal(output.operatorExecutionPlan.willModifyData, false);
  assert.equal(output.operatorExecutionPlan.trigger, "no-write-rehearsal-gates-passed");
  assert.equal(output.operatorExecutionPlan.realStagingInputClosure.status, "blocked_until_profile_and_paths");
  assert.equal(output.operatorExecutionPlan.realStagingInputClosure.readyCheckCount, 1);
  assert.equal(output.operatorExecutionPlan.realStagingInputClosure.blockedCheckCount, 4);
  assert.deepEqual(
    output.operatorExecutionPlan.realStagingInputClosure.checks.map((item) => [item.key, item.status]),
    [
      ["staging_profile", "missing"],
      ["required_secret_env", "missing"],
      ["artifact_output_paths", "missing"],
      ["artifact_archive_root", "ready"],
      ["filled_closeout_input", "not_loaded"]
    ]
  );
  assert.deepEqual(
    output.operatorExecutionPlan.realStagingInputClosure.operatorSteps.map((item) => [item.key, item.status]),
    [
      ["load_staging_profile", "operator_execute"],
      ["set_required_secret_env", "blocked_until_profile"],
      ["confirm_artifact_output_paths", "operator_prepare"],
      ["confirm_artifact_archive_root", "ready"],
      ["backfill_filled_closeout_input", "blocked_until_profile"]
    ]
  );
  assert.match(output.operatorExecutionPlan.realStagingInputClosure.operatorSteps[0].command, /--profile-file <staging-profile\.json>/);
  assert.equal(output.operatorExecutionPlan.realStagingInputClosure.operatorSteps[3].artifactPath, "artifacts/staging/PILOT_ALPHA/stable");
  assert.match(
    output.operatorExecutionPlan.realStagingInputClosure.operatorSteps[4].expectedEvidence,
    /Reload the filled closeout input and confirm the remaining missing closeout keys are empty before the full test window\./
  );
  assert.equal(output.operatorExecutionPlan.goLiveOperatorActionPlan.currentAction.key, "staging_profile");
  assert.equal(output.operatorExecutionPlan.goLiveOperatorActionPlan.remainingActionCount, 8);
  assert.deepEqual(output.operatorExecutionPlan.launchReadinessDistance, {
    mode: "launch-readiness-distance",
    status: "blocked_until_real_staging_inputs",
    launchBlockedBy: "real_environment_evidence",
    readinessPercent: 11,
    readyActionCount: 1,
    remainingOperatorActionCount: 8,
    remainingPhaseCount: 4,
    currentBlocker: {
      key: "staging_profile",
      phase: "real_staging_inputs",
      status: "missing",
      actionKind: "load_profile",
      command: "npm.cmd run staging:rehearsal -- --profile-file <staging-profile.json> --base-url https://staging.example.com --product-code PILOT_ALPHA --channel stable --admin-username admin@example.com --developer-username launch.smoke.owner --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/staging.env --app-backup-dir /var/lib/rocksolid/backups --postgres-backup-dir /var/lib/rocksolid/postgres-backups",
      artifactPath: null,
      envKeys: []
    },
    remainingBlockerKeys: [
      "staging_profile",
      "required_secret_env",
      "artifact_output_paths",
      "filled_closeout_input",
      "full_test_window",
      "production_signoff",
      "launch_day_watch",
      "stabilization_handoff"
    ],
    remainingPhases: [
      { phase: "real_staging_inputs", actionCount: 4, readyCount: 1, blockedCount: 3 },
      { phase: "full_test_window_entry", actionCount: 2, readyCount: 0, blockedCount: 2 },
      { phase: "production_signoff", actionCount: 1, readyCount: 0, blockedCount: 1 },
      { phase: "launch_watch_and_stabilization", actionCount: 2, readyCount: 0, blockedCount: 2 }
    ],
    explanation: "The application code path is prepared; launch is still blocked by real staging inputs, evidence backfill, full-test sign-off, and launch-day watch records.",
    nextAction: "Clear the real staging input closure, then rerun the no-write staging rehearsal."
  });
  assert.deepEqual(
    output.finalRehearsalPacket.launchReadinessDistance,
    output.operatorExecutionPlan.launchReadinessDistance
  );
  assert.deepEqual(
    output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.launchReadinessDistance,
    output.operatorExecutionPlan.launchReadinessDistance
  );
  assert.deepEqual(
    output.operatorExecutionPlan.goLiveOperatorActionPlan.phaseSummary.map((item) => [item.phase, item.readyCount, item.blockedCount]),
    [
      ["real_staging_inputs", 1, 3],
      ["full_test_window_entry", 0, 2],
      ["production_signoff", 0, 1],
      ["launch_watch_and_stabilization", 0, 2]
    ]
  );
  assert.deepEqual(
    output.operatorExecutionPlan.outputFiles.map((item) => [item.key, item.status]),
    [
      ["handoff_file", "not_requested"],
      ["closeout_file", "not_requested"],
      ["run_record_index", "not_requested"],
      ["artifact_manifest", "not_requested"],
      ["backup_restore_packet", "not_requested"],
      ["closeout_reload_packet", "not_requested"],
      ["readiness_review_packet", "not_requested"],
      ["production_signoff_packet", "not_requested"],
      ["launch_duty_archive_index", "not_requested"],
      ["filled_closeout_draft", "not_requested"]
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
  assert.match(output.operatorExecutionPlan.orderedSteps[1].summary, /first-batch runtime evidence/);
  assert.equal(output.operatorExecutionPlan.orderedSteps[5].endpoint, output.evidenceActionPlan.endpoint);
  assert.deepEqual(
    output.operatorExecutionPlan.requiredCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.mode, "closeout-backfill-focus");
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.status, "awaiting_closeout_backfill");
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.closeoutReviewStatus, "not_loaded");
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.missingFieldCount, 7);
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.key, "route_map_gate_result");
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.sourceStep, "run_route_map_gate");
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.artifactPath,
    "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.backfillCommand,
    "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.statusCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.paths.filledCloseoutInputFile,
    "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.paths.readinessActionQueueFile,
    "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.reloadCommand,
    "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.fullTestWindow.canRun, false);
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.fullTestWindow.command, "npm.cmd test");
  assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.productionSignoff.canSignoff, false);
  assert.deepEqual(output.operatorExecutionPlan.closeoutBackfillFocus.operatorGoNoGoResultCaptureEntry, {
    mode: "operator-go-no-go-result-capture-entry",
    key: "operator_go_no_go",
    status: "pending_operator_decision",
    willModifyData: false,
    currentActionKey: "backfill_filled_closeout_input",
    currentCommand: null,
    decision: null,
    requiredDecision: "ready-for-full-test-window",
    allowedDecisions: ["ready-for-full-test-window", "hold", "rollback-follow-up"],
    resultBackfillTarget: {
      key: "operator_go_no_go",
      status: "pending_operator_decision",
      closeoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md",
      sourceStep: "backfill_filled_closeout_input",
      receiptOperations: [],
      reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
    },
    nextAction: "Record operator_go_no_go as ready-for-full-test-window before full-test window entry."
  });
  assert.deepEqual(
    output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries.map((item) => [
      item.key,
      item.status,
      item.currentActionKey,
      item.resultBackfillTarget.artifactPath,
      item.receiptTargets[0]?.operation || null
    ]),
    [
      ["launch_smoke_handoff", "pending_operator_result", "archive_launch_smoke_handoff", "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json", "record_post_launch_ops_sweep"],
      ["launch_mainline_evidence_receipts", "pending_operator_result", "record_launch_mainline_evidence", "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json", "record_launch_rehearsal_run"],
      ["receipt_visibility_review", "pending_operator_result", "verify_receipt_visibility", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-review.txt", "record_post_launch_ops_sweep"]
    ]
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries.find((item) => item.key === "launch_mainline_evidence_receipts").evidenceEndpoint,
    output.evidenceActionPlan.endpoint
  );
  assert.equal(
    output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries.find((item) => item.key === "launch_mainline_evidence_receipts").bearerTokenEnv,
    "RSL_DEVELOPER_BEARER_TOKEN"
  );
  assert.deepEqual(
    output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries.find((item) => item.key === "receipt_visibility_review").visibilityDownloads,
    output.nextCommands.receiptVisibilitySummaries
  );
  assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.mode, "launch-duty-packet-focus");
  assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.key, "closeout_reload_packet");
  assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.status, "awaiting_closeout_backfill");
  assert.equal(
    output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.path,
    "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json"
  );
  assert.equal(
    output.operatorExecutionPlan.launchDutyPacketFocus.archiveIndexPath,
    "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"
  );
  assert.deepEqual(
    output.operatorExecutionPlan.launchDutyPacketFocus.packetSequence.map((item) => [item.key, item.status]),
    [
      ["run_record_index", "awaiting_evidence_backfill"],
      ["artifact_manifest", "awaiting_artifact_generation"],
      ["backup_restore_packet", "awaiting_backup_restore_drill"],
      ["closeout_reload_packet", "awaiting_closeout_backfill"],
      ["readiness_review_packet", "blocked_until_closeout_reload"],
      ["production_signoff_packet", "blocked_until_closeout_reload"]
    ]
  );
  assert.equal(
    output.operatorExecutionPlan.launchDutyPacketFocus.commands.closeoutReload,
    "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.status, "awaiting_closeout_backfill");
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentPhase, "full_test_window_entry");
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.sourceFocus, "closeoutBackfillFocus");
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(
    output.operatorExecutionPlan.goLiveExecutionEntry.currentCommand,
    output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.backfillCommand
  );
  assert.equal(
    output.operatorExecutionPlan.goLiveExecutionEntry.commands.closeoutReload,
    "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.commands.fullTestWindow, "npm.cmd test");
  assert.equal(
    output.operatorExecutionPlan.goLiveExecutionEntry.paths.filledCloseoutInputFile,
    "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.packetFocus.currentPacketKey, "closeout_reload_packet");
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.blockerSummary.missingCloseoutKeys.length, 7);
  assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.canRunFullTestWindow, false);
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
    closeoutEvidenceTargets: expectedCloseoutEvidenceTargets(),
    reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    resultCaptureEntry: {
      mode: "full-test-result-capture-entry",
      status: "blocked_until_closeout_reload",
      willModifyData: false,
      currentActionKey: "reload_closeout_input",
      currentCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
      resultBackfillTarget: {
        key: "full_test_window_passed",
        status: "blocked_until_full_test_window",
        closeoutInputPath: null,
        reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
        expectedEvidence: "Attach the full `npm.cmd test` output summary and failure count."
      },
      productionSignoffTarget: {
        requiredDecision: "ready-for-production-signoff",
        currentSignoffKey: "full_test_window_passed"
      },
      nextAction: "Backfill closeout input and reload it before capturing full-test results."
    },
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
    missingReceiptVisibilityKeys: expectedReceiptVisibilityKeys,
    signoffEvidenceTargets: expectedSignoffEvidenceTargets(),
    receiptVisibilityEvidenceTargets: expectedReceiptVisibilityEvidenceTargets(),
    reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: "Backfill full-test evidence, production sign-off conditions, production decision, and receipt visibility before cutover."
  });
  assert.equal(output.stagingBackupRestoreDrillPacket.mode, "staging-backup-restore-drill-operator-packet");
  assert.equal(output.stagingBackupRestoreDrillPacket.status, "awaiting_backup_restore_drill");
  assert.equal(output.stagingBackupRestoreDrillPacket.willModifyData, false);
  assert.equal(output.stagingBackupRestoreDrillPacket.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.stagingBackupRestoreDrillPacket.packetFile, "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json");
  assert.equal(output.stagingBackupRestoreDrillPacket.closeoutKey, "backup_restore_drill_result");
  assert.equal(output.stagingBackupRestoreDrillPacket.artifactPath, "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt");
  assert.equal(output.stagingBackupRestoreDrillPacket.closeoutBackfillCommand, output.preflights.recovery.closeoutBackfill.command);
  assert.equal(output.stagingBackupRestoreDrillPacket.statusCommand, output.preflights.recovery.closeoutBackfill.statusCommand);
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.receiptOperations, ["record_recovery_drill", "record_backup_verification"]);
  assert.equal(
    output.stagingBackupRestoreDrillPacket.expectedEvidence,
    "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
  );
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.resultCaptureEntry, {
    mode: "backup-restore-result-capture-entry",
    status: "awaiting_backup_restore_result",
    willModifyData: false,
    currentActionKey: "run_backup_restore_drill",
    currentCommand: output.nextCommands.recovery.restoreDrillReminder,
    commandKeys: [
      "appBackup",
      "postgresBackup",
      "postgresRestoreDryRun",
      "restoreDrillReminder",
      "healthcheck"
    ],
    resultBackfillTarget: {
      key: "backup_restore_drill_result",
      status: "pending_operator_result",
      closeoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
      sourceStep: "run_backup_restore_drill",
      receiptOperations: ["record_recovery_drill", "record_backup_verification"],
      reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
    },
    receiptTargets: [
      { operation: "record_recovery_drill", status: "pending_operator_receipt" },
      { operation: "record_backup_verification", status: "pending_operator_receipt" }
    ],
    nextAction: "Run backup/restore drill, record recovery and backup verification receipts, backfill backup_restore_drill_result, then reload closeout input."
  });
  assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.mode, "backup-restore-drill-execution-entry");
  assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.status, "awaiting_backup_restore_drill");
  assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.willModifyData, false);
  assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.currentActionKey, "run_app_backup");
  assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.currentCommand, output.nextCommands.recovery.appBackup);
  assert.deepEqual(
    output.stagingBackupRestoreDrillPacket.executionEntry.commandSequence.map((item) => [item.key, item.commandKey, item.status, item.command]),
    [
      ["run_app_backup", "appBackup", "operator_execute", output.nextCommands.recovery.appBackup],
      ["run_postgres_backup", "postgresBackup", "operator_execute", output.nextCommands.recovery.postgresBackup],
      ["run_postgres_restore_dry_run", "postgresRestoreDryRun", "operator_execute", output.nextCommands.recovery.postgresRestoreDryRun],
      ["run_restore_healthcheck", "healthcheck", "operator_execute", output.nextCommands.recovery.healthcheck]
    ]
  );
  assert.deepEqual(
    output.stagingBackupRestoreDrillPacket.executionEntry.receiptQueue.map((item) => [item.operation, item.status]),
    [
      ["record_recovery_drill", "pending_operator_receipt"],
      ["record_backup_verification", "pending_operator_receipt"]
    ]
  );
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.executionEntry.closeoutBackfillTarget, {
    key: "backup_restore_drill_result",
    status: "pending_operator_result",
    closeoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
    sourceStep: "run_backup_restore_drill",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"],
    expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
  });
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.executionEntry.closeoutReload, {
    status: "blocked_until_backup_restore_backfill",
    command: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    closeoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  });
  assert.equal(
    output.stagingBackupRestoreDrillPacket.executionEntry.nextAction,
    "Run backup/restore commands in order, record both receipts, backfill backup_restore_drill_result, then reload closeout input."
  );
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.commandKeys, [
    "appBackup",
    "postgresBackup",
    "postgresRestoreDryRun",
    "restoreDrillReminder",
    "healthcheck"
  ]);
  assert.equal(output.stagingBackupRestoreDrillPacket.commands.appBackup, output.nextCommands.recovery.appBackup);
  assert.equal(output.stagingBackupRestoreDrillPacket.commands.postgresRestoreDryRun, output.nextCommands.recovery.postgresRestoreDryRun);
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.environment, {
    targetOs: "linux",
    storageProfile: "postgres-preview",
    targetEnvFile: "/etc/rocksolidlicense/staging.env",
    appBackupDir: "/var/lib/rocksolid/backups",
    postgresBackupDir: "/var/lib/rocksolid/postgres-backups"
  });
  assert.deepEqual(output.stagingBackupRestoreDrillPacket.sourceStatuses, {
    recoveryPreflight: "pass",
    environmentReadiness: "needs_operator_execution",
    executionRunbook: "ready_for_real_staging_dry_run",
    closeoutInput: "not_loaded"
  });
  assert.deepEqual(
    output.stagingBackupRestoreDrillPacket.operatorSteps.map((item) => [item.key, item.status]),
    [
      ["run_app_backup", "operator_execute"],
      ["run_postgres_backup", "operator_execute"],
      ["run_postgres_restore_dry_run", "operator_execute"],
      ["record_recovery_drill_receipt", "operator_execute"],
      ["record_backup_verification_receipt", "operator_execute"],
      ["backfill_closeout_key", "operator_backfill"]
    ]
  );
  assert.deepEqual(
    output.stagingBackupRestoreDrillPacket.operatorSteps.map((item) => [item.key, item.expectedEvidence]),
    [
      ["run_app_backup", "Capture app backup command exit status and backup artifact path."],
      ["run_postgres_backup", "Capture Postgres backup command exit status and backup artifact path for postgres-preview storage."],
      ["run_postgres_restore_dry_run", "Capture restore dry-run exit status and separate restore-target healthcheck result."],
      ["record_recovery_drill_receipt", "Record the recovery drill receipt ID for the restore dry-run and healthcheck evidence."],
      ["record_backup_verification_receipt", "Record the backup verification receipt ID for the app/Postgres backup artifacts."],
      ["backfill_closeout_key", "Backfill backup_restore_drill_result with the backup artifact path, restore dry-run result, healthcheck result, and receipt IDs."]
    ]
  );
  assert.equal(output.stagingBackupRestoreDrillPacket.closeoutReloadCommand, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingBackupRestoreDrillPacket.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingBackupRestoreDrillPacket.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingBackupRestoreDrillPacket.goLiveExecutionEntry.commands.closeoutReload, output.stagingBackupRestoreDrillPacket.closeoutReloadCommand);
  assert.equal(output.stagingBackupRestoreDrillPacket.nextAction, "Run the backup/restore drill commands on the restore target, record recovery and backup verification receipts, then backfill backup_restore_drill_result.");
  assert.equal(output.stagingProductionSignoffPacket.mode, "staging-production-signoff-operator-packet");
  assert.equal(output.stagingProductionSignoffPacket.status, "blocked_until_closeout_reload");
  assert.equal(output.stagingProductionSignoffPacket.willModifyData, false);
  assert.equal(output.stagingProductionSignoffPacket.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.stagingProductionSignoffPacket.packetFile, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json");
  assert.deepEqual(output.stagingProductionSignoffPacket.sourceStatuses, {
    fullTestWindow: "blocked",
    productionSignoff: "blocked",
    readinessReviewPacket: "blocked_until_closeout_reload",
    runRecordIndex: "awaiting_evidence_backfill",
    launchDayWatch: "blocked"
  });
  assert.deepEqual(output.stagingProductionSignoffPacket.decision, {
    requiredDecision: "ready-for-production-signoff",
    productionDecision: null,
    canSignoff: false,
    readyForFullTestWindow: false,
    closeoutInputStatus: "missing"
  });
  assert.deepEqual(
    output.stagingProductionSignoffPacket.missingSignoffKeys,
    output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key)
  );
  assert.deepEqual(output.stagingProductionSignoffPacket.requiredReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
  assert.deepEqual(output.stagingProductionSignoffPacket.missingReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
  assert.deepEqual(
    output.stagingProductionSignoffPacket.signoffConditions.map((item) => ({
      key: item.key,
      status: item.status,
      expectedEvidence: item.expectedEvidence
    })),
    expectedSignoffEvidenceTargets()
  );
  assert.deepEqual(
    output.stagingProductionSignoffPacket.receiptVisibilityEvidenceTargets,
    expectedReceiptVisibilityEvidenceTargets()
  );
  assert.deepEqual(
    output.stagingProductionSignoffPacket.postSignoffTargets.map((item) => [item.key, item.status, item.path]),
    [
      ["production_signoff_packet", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
      ["launch_day_watch_summary", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["launch_duty_archive_index", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"],
      ["stabilization_owner_handoff", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"],
      ["first_wave_closeout", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"]
    ]
  );
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.status, "blocked_until_signoff_ready");
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.sourceStatus, "blocked");
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.watchRecordDraftStatus, "blocked_until_production_signoff");
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.watchStartGate, "production_signoff_readiness");
  assert.equal(
    output.stagingProductionSignoffPacket.launchDayWatchBridge.launchDutyArchiveIndexPath,
    "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"
  );
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentPostSignoffTarget.key, "production_signoff_packet");
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentWatchArtifact.key, "launch_day_watch_summary");
  assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentStabilizationWindow.key, "stabilization_owner_handoff");
  assert.deepEqual(
    output.stagingProductionSignoffPacket.launchDayWatchBridge.evidenceInputs.map((item) => [item.key, item.status, item.path]),
    [
      ["production_signoff_packet", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
      ["launch_day_watch_summary", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["stabilization_owner_handoff", "blocked_until_cutover_watch", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(
    output.stagingProductionSignoffPacket.launchDayWatchBridge.watchRecordQueue.map((item) => [item.key, item.status]),
    [
      ["launch_day_watch_summary", "blocked_until_production_signoff"],
      ["receipt_visibility_snapshot", "blocked_until_production_signoff"],
      ["first_wave_incident_log", "blocked_until_production_signoff"],
      ["rollback_signal_review", "blocked_until_production_signoff"],
      ["stabilization_owner_handoff", "blocked_until_production_signoff"]
    ]
  );
  assert.deepEqual(
    output.stagingProductionSignoffPacket.launchDayWatchBridge.stabilizationWindows.map((item) => [item.key, item.status]),
    [
      ["stabilization_owner_handoff", "blocked_until_cutover_watch"],
      ["first_wave_closeout", "blocked_until_stabilization_owner_handoff"]
    ]
  );
  assert.equal(
    output.stagingProductionSignoffPacket.routes.launchOpsOverviewStatus,
    output.nextCommands.receiptVisibilitySummaries.launchOpsOverviewStatus
  );
  assert.equal(output.stagingProductionSignoffPacket.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingProductionSignoffPacket.commands.fullTestWindow, "npm.cmd test");
  assert.equal(output.stagingProductionSignoffPacket.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingProductionSignoffPacket.goLiveExecutionEntry.status, "awaiting_closeout_backfill");
  assert.equal(output.stagingProductionSignoffPacket.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingProductionSignoffPacket.goLiveExecutionEntry.commands.closeoutReload, output.stagingProductionSignoffPacket.commands.closeoutReload);
  assert.equal(output.stagingProductionSignoffPacket.goLiveExecutionEntry.commands.fullTestWindow, "npm.cmd test");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.mode, "production-signoff-execution-entry");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.status, "blocked_until_full_test_window");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.willModifyData, false);
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.currentActionKey, "run_full_test_window");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.currentCommand, "npm.cmd test");
  assert.deepEqual(
    output.stagingProductionSignoffPacket.operatorGoNoGoResultCaptureEntry,
    output.operatorExecutionPlan.closeoutBackfillFocus.operatorGoNoGoResultCaptureEntry
  );
  assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.fullTestWindow, {
    status: "blocked",
    canRun: false,
    command: "npm.cmd test"
  });
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.status, "blocked_until_full_test_window");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.packetFile, output.stagingProductionSignoffPacket.packetFile);
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.reloadCommand, output.stagingProductionSignoffPacket.commands.closeoutReload);
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.currentSignoffKey, "full_test_window_passed");
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.currentReceiptVisibilityKey, "launchMainline");
  assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.missingSignoffKeys, expectedProductionSignoffConditionKeys);
  assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.missingReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
  assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.launchDayWatch, {
    status: "blocked_until_signoff_ready",
    currentTargetKey: "production_signoff_packet",
    nextAction: "Do not start launch-day watch until production sign-off readiness is ready."
  });
  assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.nextAction, "Run the full test window, backfill production sign-off and receipt visibility, then reload closeout input.");
  assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.status, "blocked_until_full_test_window");
  assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.reloadCommand, output.stagingProductionSignoffPacket.commands.closeoutReload);
  assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.productionSignoff.decision, null);
  assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.productionSignoff.requiredDecision, "ready-for-production-signoff");
  assert.deepEqual(
    output.stagingProductionSignoffPacket.signoffBackfillDraft.productionSignoff.conditions.map((item) => [item.key, item.status, item.value]),
    expectedProductionSignoffConditionKeys.map((key) => [key, "pending_operator_entry", null])
  );
  assert.deepEqual(Object.keys(output.stagingProductionSignoffPacket.signoffBackfillDraft.receiptVisibility), expectedReceiptVisibilityKeys);
  assert.match(output.stagingProductionSignoffPacket.signoffBackfillDraft.operatorNote, /redacted/);
  assert.deepEqual(
    output.stagingProductionSignoffPacket.operatorSteps.map((item) => [item.key, item.status]),
    [
      ["run_full_test_window", "blocked_until_closeout_reload"],
      ["backfill_production_signoff", "blocked_until_full_test_window"],
      ["verify_receipt_visibility", "operator_backfill"],
      ["reload_closeout_input", "operator_execute"],
      ["archive_production_signoff", "blocked_until_signoff_ready"],
      ["start_launch_day_watch", "blocked_until_signoff_ready"]
    ]
  );
  assert.deepEqual(
    output.stagingProductionSignoffPacket.operatorSteps.map((item) => [item.key, item.expectedEvidence]),
    [
      ["run_full_test_window", "Run npm.cmd test and capture the pass/fail summary before production sign-off."],
      ["backfill_production_signoff", "Backfill every production sign-off condition with redacted full-test and release-readiness evidence."],
      ["verify_receipt_visibility", "Confirm Launch Mainline, Launch Review, Launch Smoke, Developer Ops, and Launch Ops Overview Status receipt visibility before cutover."],
      ["reload_closeout_input", "Reload the filled closeout input and confirm production sign-off readiness is recalculated from redacted evidence."],
      ["archive_production_signoff", "Archive the signed production sign-off packet with full-test status, GO/NO-GO decision, and receipt visibility lanes."],
      ["start_launch_day_watch", "Start launch-day watch only after production sign-off and receipt visibility are ready."]
    ]
  );
  assert.equal(output.stagingProductionSignoffPacket.nextAction, "Reload closeout input, run the full test window when ready, then backfill production sign-off evidence and receipt visibility.");
  assert.equal(output.launchDayWatchPlan.status, "blocked");
  assert.equal(output.launchDayWatchPlan.canStartCutoverWatch, false);
  assert.equal(output.launchDayWatchPlan.requiredDecision, "ready-for-production-signoff");
  assert.equal(output.launchDayWatchPlan.productionDecision, null);
  assert.deepEqual(output.launchDayWatchPlan.missingSignoffKeys, output.productionSignoffReadiness.missingSignoffKeys);
  assert.deepEqual(output.launchDayWatchPlan.missingReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
  assert.equal(output.launchDayWatchPlan.watchRecordDraft.status, "blocked_until_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchRecordDraft.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.mode, "launch-day-watch-execution-entry");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.status, "blocked_until_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.willModifyData, false);
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentActionKey, "complete_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.key, "launch_day_watch_summary");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.status, "blocked_until_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.path, "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md");
  assert.deepEqual(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.receiptOperations, ["record_cutover_walkthrough", "record_launch_day_readiness_review"]);
  assert.deepEqual(output.launchDayWatchPlan.watchExecutionEntry.stabilizationTarget, {
    key: "stabilization_owner_handoff",
    status: "blocked_until_production_signoff",
    path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
    receiptOperations: ["record_launch_stabilization_review"]
  });
  assert.equal(output.launchDayWatchPlan.watchExecutionEntry.nextAction, "Complete production sign-off before starting launch-day watch records.");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.mode, "launch-day-watch-evidence-execution-entry");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.status, "blocked_until_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.willModifyData, false);
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentEvidenceKey, "launch_day_watch_summary");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentActionKey, "complete_production_signoff");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentCommand, null);
  assert.deepEqual(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.evidenceQueue.map((item) => [
      item.key,
      item.category,
      item.status,
      item.currentActionKey,
      item.artifactPath,
      item.receiptOperations
    ]),
    [
      ["launch_day_watch_summary", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md", ["record_cutover_walkthrough", "record_launch_day_readiness_review"]],
      ["receipt_visibility_snapshot", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt", ["record_post_launch_ops_sweep"]],
      ["first_wave_incident_log", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md", ["record_post_launch_ops_sweep"]],
      ["rollback_signal_review", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md", ["record_rollback_walkthrough", "record_launch_stabilization_review"]],
      ["stabilization_owner_handoff", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md", ["record_launch_stabilization_review"]]
    ]
  );
  assert.deepEqual(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.receiptQueue.map((item) => [item.key, item.operation, item.status, item.artifactPath]),
    [
      ["launch_day_watch_summary", "record_cutover_walkthrough", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["launch_day_watch_summary", "record_launch_day_readiness_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "record_post_launch_ops_sweep", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "record_post_launch_ops_sweep", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "record_rollback_walkthrough", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["rollback_signal_review", "record_launch_stabilization_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "record_launch_stabilization_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(output.launchDayWatchPlan.watchEvidenceExecutionEntry.stabilizationHandoff, {
    key: "stabilization_owner_handoff",
    status: "blocked_until_production_signoff",
    path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
    receiptOperations: ["record_launch_stabilization_review"]
  });
  assert.equal(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.nextAction,
    "Complete production sign-off before starting launch-day watch evidence capture."
  );
  assert.deepEqual(
    output.launchDayWatchPlan.watchRecordDraft.records.map((item) => [item.key, item.status]),
    [
      ["launch_day_watch_summary", "blocked_until_production_signoff"],
      ["receipt_visibility_snapshot", "blocked_until_production_signoff"],
      ["first_wave_incident_log", "blocked_until_production_signoff"],
      ["rollback_signal_review", "blocked_until_production_signoff"],
      ["stabilization_owner_handoff", "blocked_until_production_signoff"]
    ]
  );
  assert.deepEqual(
    output.launchDayWatchPlan.watchEvidenceCaptureEntries.map((item) => [
      item.key,
      item.category,
      item.status,
      item.currentActionKey,
      item.resultBackfillTarget.artifactPath,
      item.receiptTargets.map((target) => target.operation)
    ]),
    [
      ["launch_day_watch_summary", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md", ["record_cutover_walkthrough", "record_launch_day_readiness_review"]],
      ["receipt_visibility_snapshot", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt", ["record_post_launch_ops_sweep"]],
      ["first_wave_incident_log", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md", ["record_post_launch_ops_sweep"]],
      ["rollback_signal_review", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md", ["record_rollback_walkthrough", "record_launch_stabilization_review"]],
      ["stabilization_owner_handoff", "launch_day_watch_record", "blocked_until_production_signoff", "complete_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md", ["record_launch_stabilization_review"]]
    ]
  );
  assert.deepEqual(
    output.launchDayWatchPlan.watchWindows.map((item) => item.key),
    ["cutover_watch", "first_wave_stabilization"]
  );
  assert.equal(
    output.launchDayWatchPlan.routes.developerOps,
    "https://staging.example.com/developer/ops?productCode=PILOT_ALPHA&source=staging-rehearsal&handoff=first-wave"
  );
  assert.equal(
    output.launchDayWatchPlan.routes.launchOpsOverviewStatus,
    output.nextCommands.receiptVisibilitySummaries.launchOpsOverviewStatus
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
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.mode, "stabilization-handoff-execution-entry");
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.status, "blocked_until_cutover_watch");
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.willModifyData, false);
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentActionKey, "verify_cutover_watch_records");
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.key, "stabilization_owner_handoff");
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.status, "blocked_until_cutover_watch");
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.path, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md");
  assert.deepEqual(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.receiptOperations, ["record_launch_stabilization_review"]);
  assert.deepEqual(output.stabilizationHandoffPlan.handoffExecutionEntry.requiredSourceRecordKeys, [
    "launch_day_watch_summary",
    "first_wave_incident_log",
    "receipt_visibility_snapshot",
    "rollback_signal_review",
    "stabilization_owner_handoff"
  ]);
  assert.deepEqual(
    output.stabilizationHandoffPlan.handoffExecutionEntry.sourceRecordQueue.map((item) => [item.key, item.status, item.path]),
    [
      ["launch_day_watch_summary", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["first_wave_incident_log", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["receipt_visibility_snapshot", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["rollback_signal_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(output.stabilizationHandoffPlan.handoffExecutionEntry.firstWaveCloseoutTarget, {
    key: "first_wave_closeout",
    status: "blocked_until_stabilization_owner_handoff",
    path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
    receiptOperations: ["record_launch_closeout_review"]
  });
  assert.deepEqual(output.stabilizationHandoffPlan.firstWaveCloseoutCaptureEntry, {
    mode: "first-wave-closeout-capture-entry",
    key: "first_wave_closeout",
    category: "stabilization_closeout",
    status: "blocked_until_stabilization_owner_handoff",
    willModifyData: false,
    currentActionKey: "verify_cutover_watch_records",
    currentCommand: null,
    resultBackfillTarget: {
      key: "first_wave_closeout",
      status: "blocked_until_stabilization_owner_handoff",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      sourceRecords: [
        ["first_wave_incident_log", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["rollback_signal_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ],
      receiptOperations: ["record_launch_closeout_review"],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
    },
    receiptTargets: [
      {
        operation: "record_launch_closeout_review",
        status: "blocked_until_stabilization_handoff",
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
      }
    ],
    nextAction: "Start launch-day watch and stabilization handoff before first-wave closeout."
  });
  assert.deepEqual(output.stabilizationHandoffPlan.firstWaveCloseoutExecutionEntry, {
    mode: "first-wave-closeout-execution-entry",
    status: "blocked_until_stabilization_owner_handoff",
    willModifyData: false,
    currentActionKey: "verify_cutover_watch_records",
    currentCommand: null,
    closeoutTarget: {
      key: "first_wave_closeout",
      status: "blocked_until_stabilization_owner_handoff",
      path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
    },
    sourceRecordQueue: [
      { key: "first_wave_incident_log", status: "blocked_until_production_signoff", path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md" },
      { key: "rollback_signal_review", status: "blocked_until_production_signoff", path: "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md" },
      { key: "stabilization_owner_handoff", status: "blocked_until_production_signoff", path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md" }
    ],
    receiptQueue: [
      {
        key: "first_wave_closeout",
        operation: "record_launch_closeout_review",
        status: "blocked_until_stabilization_handoff",
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
      }
    ],
    nextAction: "Start launch-day watch and stabilization handoff before first-wave closeout."
  });
  assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.nextAction, "Complete launch-day watch records before handing off stabilization owner.");
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
  assert.equal(
    output.stabilizationHandoffPlan.routes.launchOpsOverviewStatus,
    output.nextCommands.receiptVisibilitySummaries.launchOpsOverviewStatus
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
  assert.deepEqual(
    output.stabilizationHandoffPlan.handoffWindows.map((item) => [item.key, item.receiptOperations, item.expectedEvidence]),
    [
      ["stabilization_owner_handoff", ["record_launch_stabilization_review"], "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
      ["first_wave_closeout", ["record_launch_closeout_review"], "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
    ]
  );
  assert.equal(output.stabilizationHandoffPlan.currentHandoffTarget.key, "stabilization_owner_handoff");
  assert.equal(output.stabilizationHandoffPlan.currentHandoffTarget.path, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md");
  assert.deepEqual(
    output.stabilizationHandoffPlan.sourceWatchRecords.map((item) => [item.key, item.status, item.path]),
    [
      ["launch_day_watch_summary", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["first_wave_incident_log", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["receipt_visibility_snapshot", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["rollback_signal_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(
    output.stabilizationHandoffPlan.handoffEvidenceInputs.map((item) => [item.key, item.status, item.path]),
    output.stabilizationHandoffPlan.sourceWatchRecords.map((item) => [item.key, item.status, item.path])
  );
  assert.deepEqual(
    output.stabilizationHandoffPlan.operatorSteps.map((item) => [item.key, item.status]),
    [
      ["verify_cutover_watch_records", "blocked_until_cutover_watch"],
      ["handoff_stabilization_owner", "blocked_until_cutover_watch"],
      ["close_first_wave", "blocked_until_stabilization_owner_handoff"]
    ]
  );
  assert.deepEqual(
    output.stabilizationHandoffPlan.operatorSteps[0].artifactPaths,
    output.stabilizationHandoffPlan.sourceWatchRecords.map((item) => item.path)
  );
  assert.match(
    output.stabilizationHandoffPlan.operatorSteps[1].expectedEvidence,
    /stabilization owner/
  );
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
    "stabilization_owner_handoff",
    "first_wave_closeout"
  ]);
  assert.deepEqual(
    output.stagingRunRecordTemplate.records.slice(-6).map((item) => [item.key, item.sourcePlan, item.artifactPath]),
    [
      ["launch_day_watch_summary", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["first_wave_incident_log", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["receipt_visibility_snapshot", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["rollback_signal_review", "stabilizationHandoffPlan", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "stabilizationHandoffPlan", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"],
      ["first_wave_closeout", "stabilizationHandoffPlan", "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"]
    ]
  );
  assert.equal(
    output.stagingRunRecordTemplate.records.find((item) => item.key === "route_map_gate_result").expectedEvidence,
    "Record the targeted gate exit status, pass count, and redacted output artifact path."
  );
  assert.deepEqual(
    output.stagingRunRecordTemplate.records.slice(-6).map((item) => [item.key, item.expectedEvidence]),
    [
      ["launch_day_watch_summary", "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
      ["first_wave_incident_log", "Record first-wave incidents, customer impact, mitigation, owner, and status."],
      ["receipt_visibility_snapshot", "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
      ["rollback_signal_review", "Record whether rollback signals were observed, dismissed, or escalated."],
      ["stabilization_owner_handoff", "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
      ["first_wave_closeout", "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
    ]
  );
  assert.equal(output.stagingRehearsalRunRecordIndex.mode, "staging-rehearsal-run-record-index");
  assert.equal(output.stagingRehearsalRunRecordIndex.status, "awaiting_evidence_backfill");
  assert.equal(output.stagingRehearsalRunRecordIndex.willModifyData, false);
  assert.equal(output.stagingRehearsalRunRecordIndex.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(output.stagingRehearsalRunRecordIndex.sourceStatuses, {
    runRecordTemplate: "awaiting_staging_execution",
    executionSummary: "profile_not_loaded",
    finalPacket: "ready_for_operator_rehearsal",
    closeoutInput: "not_loaded"
  });
  assert.equal(output.stagingRehearsalRunRecordIndex.recordCount, output.stagingRunRecordTemplate.records.length);
  assert.deepEqual(
    output.stagingRehearsalRunRecordIndex.closeoutProgress.missingRecordKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.equal(output.stagingRehearsalRunRecordIndex.closeoutProgress.missingRecordCount, 7);
  assert.equal(output.stagingRehearsalRunRecordIndex.closeoutProgress.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingRehearsalRunRecordIndex.closeoutProgress.reloadCommand, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingRehearsalRunRecordIndex.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingRehearsalRunRecordIndex.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingRehearsalRunRecordIndex.goLiveExecutionEntry.paths.filledCloseoutInputFile, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.deepEqual(
    output.stagingRehearsalRunRecordIndex.recordGroups.map((item) => [item.key, item.status, item.recordCount]),
    [
      ["pre_full_test_closeout", "awaiting_operator_evidence", 7],
      ["production_signoff", "blocked_until_full_test_window", expectedProductionSignoffConditionKeys.length],
      ["launch_day_watch_and_stabilization", "blocked_until_production_signoff", 6]
    ]
  );
  assert.equal(
    output.stagingRehearsalRunRecordIndex.recordGroups
      .find((item) => item.key === "pre_full_test_closeout")
      .records.find((item) => item.key === "route_map_gate_result").expectedEvidence,
    "Record the targeted gate exit status, pass count, and redacted output artifact path."
  );
  assert.deepEqual(
    output.stagingRehearsalRunRecordIndex.recordGroups
      .find((item) => item.key === "launch_day_watch_and_stabilization")
      .records.map((item) => [item.key, item.expectedEvidence]),
    [
      ["launch_day_watch_summary", "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
      ["first_wave_incident_log", "Record first-wave incidents, customer impact, mitigation, owner, and status."],
      ["receipt_visibility_snapshot", "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
      ["rollback_signal_review", "Record whether rollback signals were observed, dismissed, or escalated."],
      ["stabilization_owner_handoff", "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
      ["first_wave_closeout", "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
    ]
  );
  assert.deepEqual(
    output.stagingRehearsalRunRecordIndex.orderedOperatorMilestones.slice(0, 5),
    [
      "generate_rehearsal_outputs",
      "collect_pre_full_test_records",
      "backfill_filled_closeout_input",
      "reload_closeout_input",
      "run_full_test_window"
    ]
  );
  assert.equal(output.stagingRehearsalRunRecordIndex.nextAction, "Collect the missing pre-full-test record artifacts, backfill filled-closeout-input.json, then reload closeout input.");
  assert.equal(output.stagingArtifactManifest.mode, "staging-artifact-manifest");
  assert.equal(output.stagingArtifactManifest.status, "awaiting_artifact_generation");
  assert.equal(output.stagingArtifactManifest.willModifyData, false);
  assert.equal(output.stagingArtifactManifest.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(
    output.stagingArtifactManifest.files.map((item) => [item.key, item.path, item.status]),
    [
      ["handoff_file", "artifacts/staging/PILOT_ALPHA/stable/staging-rehearsal-handoff.md", "recommended_default"],
      ["closeout_file", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-template.json", "recommended_default"],
      ["run_record_index", "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json", "recommended_default"],
      ["artifact_manifest", "artifacts/staging/PILOT_ALPHA/stable/staging-artifact-manifest.json", "recommended_default"],
      ["backup_restore_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json", "recommended_default"],
      ["closeout_reload_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json", "recommended_default"],
      ["readiness_review_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json", "recommended_default"],
      ["production_signoff_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", "recommended_default"],
      ["launch_duty_archive_index", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json", "recommended_default"],
      ["filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json", "operator_create"],
      ["filled_closeout_draft", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json", "example_only"],
      ["readiness_action_queue", "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md", "operator_generate"],
      ["filled_closeout_input_example", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json", "example_only"],
      ["artifact_archive_root", "artifacts/staging/PILOT_ALPHA/stable", "operator_archive"]
    ]
  );
  assert.deepEqual(output.stagingArtifactManifest.sourceStatuses, {
    profilePreflight: "profile_not_loaded",
    executionSummary: "profile_not_loaded",
    runRecordIndex: "awaiting_evidence_backfill",
    finalPacket: "ready_for_operator_rehearsal"
  });
  assert.equal(output.stagingArtifactManifest.commands.closeoutInit, "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md");
  assert.equal(output.stagingArtifactManifest.commands.readinessStatus, "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md");
  assert.equal(output.stagingArtifactManifest.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingArtifactManifest.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingArtifactManifest.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingArtifactManifest.goLiveExecutionEntry.packetFocus.currentPacketKey, "closeout_reload_packet");
  assert.equal(output.stagingArtifactManifest.nextAction, "Generate and archive the listed rehearsal artifacts, then fill closeout evidence from the draft before reloading closeout input.");
  assert.equal(output.stagingCloseoutReloadPacket.mode, "staging-closeout-reload-packet");
  assert.equal(output.stagingCloseoutReloadPacket.status, "awaiting_closeout_backfill");
  assert.equal(output.stagingCloseoutReloadPacket.willModifyData, false);
  assert.equal(output.stagingCloseoutReloadPacket.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(output.stagingCloseoutReloadPacket.paths, {
    packetFile: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json",
    filledCloseoutDraftFile: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json",
    filledCloseoutInputFile: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    closeoutTemplateFile: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-template.json"
  });
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.postReloadTargets.map((item) => [item.key, item.path, item.status]),
    [
      ["readiness_review_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json", "review_after_reload"],
      ["production_signoff_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", "prepare_after_full_test"],
      ["launch_duty_archive_index", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json", "archive_after_signoff"]
    ]
  );
  assert.match(
    output.stagingCloseoutReloadPacket.postReloadTargets[0].expectedEvidence,
    /Review the reloaded closeout status, remaining missing closeout keys, and full-test readiness from the readiness review packet\./
  );
  assert.equal(output.stagingCloseoutReloadPacket.postReloadTargets[1].command, "npm.cmd test");
  assert.equal(output.stagingCloseoutReloadPacket.postReloadTargets[1].requiredDecision, "ready-for-production-signoff");
  assert.match(
    output.stagingCloseoutReloadPacket.postReloadTargets[2].expectedEvidence,
    /Archive the signed production sign-off packet and prepare launch-day watch plus stabilization artifacts\./
  );
  assert.deepEqual(output.stagingCloseoutReloadPacket.sourceStatuses, {
    closeoutInput: "not_loaded",
    closeoutReview: "not_loaded",
    backupRestorePacket: "awaiting_backup_restore_drill",
    readinessTransition: "blocked_until_closeout_reload",
    finalPacket: "ready_for_operator_rehearsal",
    artifactManifest: "awaiting_artifact_generation"
  });
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.missingCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.operatorSteps.map((item) => item.key),
    [
      "promote_filled_closeout_draft",
      "backfill_required_evidence",
      "remove_example_only_guard",
      "reload_closeout_input",
      "review_full_test_window_readiness"
    ]
  );
  assert.equal(output.stagingCloseoutReloadPacket.operatorSteps[0].from, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json");
  assert.equal(output.stagingCloseoutReloadPacket.operatorSteps[0].to, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.operatorSteps[1].missingCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.match(
    output.stagingCloseoutReloadPacket.operatorSteps[1].expectedEvidence,
    /Backfill every missing closeout key with redacted artifact paths, receipt IDs, and operator decisions before reload\./
  );
  assert.equal(output.stagingCloseoutReloadPacket.operatorSteps[2].expected, "exampleOnly must be absent or false before reload.");
  assert.match(
    output.stagingCloseoutReloadPacket.operatorSteps[4].expectedEvidence,
    /Review the readiness review packet after reload and only run npm\.cmd test once missing closeout keys are empty\./
  );
  assert.equal(output.stagingCloseoutReloadPacket.reloadExecutionEntry.mode, "closeout-reload-execution-entry");
  assert.equal(output.stagingCloseoutReloadPacket.reloadExecutionEntry.status, "awaiting_backfill");
  assert.equal(output.stagingCloseoutReloadPacket.reloadExecutionEntry.currentBackfillKey, "route_map_gate_result");
  assert.equal(output.stagingCloseoutReloadPacket.reloadExecutionEntry.backfillQueueCount, 7);
  assert.equal(output.stagingCloseoutReloadPacket.reloadExecutionEntry.missingBackfillCount, 7);
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.postLiveWriteResultCaptureEntries,
    output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries
  );
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.mode, "post-live-write-execution-entry");
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.status, "awaiting_post_live_write_capture");
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.willModifyData, false);
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentCaptureKey, "launch_smoke_handoff");
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentActionKey, "archive_launch_smoke_handoff");
  assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentCommand, null);
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.captureQueue.map((item) => [
      item.key,
      item.status,
      item.currentActionKey,
      item.artifactPath,
      item.receiptOperations[0] || null
    ]),
    [
      ["launch_smoke_handoff", "pending_operator_result", "archive_launch_smoke_handoff", "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json", "record_post_launch_ops_sweep"],
      ["launch_mainline_evidence_receipts", "pending_operator_result", "record_launch_mainline_evidence", "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json", "record_launch_rehearsal_run"],
      ["receipt_visibility_review", "pending_operator_result", "verify_receipt_visibility", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-review.txt", "record_post_launch_ops_sweep"]
    ]
  );
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.receiptQueue.slice(0, 3).map((item) => [item.key, item.operation, item.status]),
    [
      ["launch_smoke_handoff", "record_post_launch_ops_sweep", "pending_operator_receipt"],
      ["launch_mainline_evidence_receipts", "record_launch_rehearsal_run", "pending_operator_receipt"],
      ["launch_mainline_evidence_receipts", "record_recovery_drill", "pending_operator_receipt"]
    ]
  );
  assert.deepEqual(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.closeoutReload, {
    status: "blocked_until_post_live_write_backfill",
    command: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    closeoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  });
  assert.equal(
    output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.nextAction,
    "Capture launch_smoke_handoff, backfill the closeout input, then reload closeout readiness."
  );
  assert.deepEqual(
    output.stagingCloseoutReloadPacket.reloadExecutionEntry.backfillQueue.map((item) => [item.key, item.status, item.sourceStep, item.artifactPath]),
    [
      ["route_map_gate_result", "missing", "run_route_map_gate", "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"],
      ["backup_restore_drill_result", "missing", "run_backup_restore_drill", "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt"],
      ["live_write_smoke_result", "missing", "run_live_write_smoke", "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json"],
      ["launch_smoke_handoff", "missing", "archive_launch_smoke_handoff", "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json"],
      ["launch_mainline_evidence_receipts", "missing", "record_launch_mainline_evidence", "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json"],
      ["receipt_visibility_review", "missing", "verify_receipt_visibility", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-review.txt"],
      ["operator_go_no_go", "missing", "backfill_filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"]
    ]
  );
  assert.deepEqual(output.stagingCloseoutReloadPacket.reloadExecutionEntry.postReloadReview, {
    key: "readiness_review_packet",
    status: "blocked",
    canRunFullTestWindow: false,
    command: "npm.cmd test",
    missingCloseoutKeys: output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key),
    nextAction: "Backfill missing staging closeout fields, reload the closeout input, then re-check this gate before running the full test suite."
  });
  assert.equal(output.stagingCloseoutReloadPacket.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingCloseoutReloadPacket.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingCloseoutReloadPacket.goLiveExecutionEntry.status, "awaiting_closeout_backfill");
  assert.equal(output.stagingCloseoutReloadPacket.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingCloseoutReloadPacket.goLiveExecutionEntry.commands.closeoutReload, output.stagingCloseoutReloadPacket.commands.closeoutReload);
  assert.equal(output.stagingCloseoutReloadPacket.nextAction, "Backfill the real filled closeout input, reload it, then review full-test-window readiness before running npm.cmd test.");
  assert.equal(output.stagingReadinessReviewPacket.mode, "staging-readiness-review-packet");
  assert.equal(output.stagingReadinessReviewPacket.status, "blocked_until_closeout_reload");
  assert.equal(output.stagingReadinessReviewPacket.willModifyData, false);
  assert.equal(output.stagingReadinessReviewPacket.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.stagingReadinessReviewPacket.packetFile, "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json");
  assert.deepEqual(output.stagingReadinessReviewPacket.sourceStatuses, {
    closeoutReloadPacket: "awaiting_closeout_backfill",
    fullTestWindow: "blocked",
    productionSignoff: "blocked",
    launchDayWatch: "blocked",
    stabilizationHandoff: "blocked",
    finalPacket: "ready_for_operator_rehearsal"
  });
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.map((item) => [item.key, item.status, item.canProceed]),
    [
      ["full_test_window", "blocked", false],
      ["production_signoff", "blocked", false],
      ["launch_day_watch", "blocked", false],
      ["stabilization_handoff", "blocked", false]
    ]
  );
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.find((item) => item.key === "full_test_window").missingCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.find((item) => item.key === "full_test_window").closeoutEvidenceTargets,
    expectedCloseoutEvidenceTargets()
  );
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.find((item) => item.key === "production_signoff").signoffEvidenceTargets,
    expectedSignoffEvidenceTargets()
  );
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.find((item) => item.key === "production_signoff").missingReceiptVisibilityKeys,
    expectedReceiptVisibilityKeys
  );
  assert.deepEqual(
    output.stagingReadinessReviewPacket.gates.find((item) => item.key === "production_signoff").receiptVisibilityEvidenceTargets,
    expectedReceiptVisibilityEvidenceTargets()
  );
  assert.equal(output.stagingReadinessReviewPacket.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingReadinessReviewPacket.commands.fullTestWindow, "npm.cmd test");
  assert.deepEqual(output.stagingReadinessReviewPacket.fullTestEntryExecution, {
    mode: "full-test-entry-execution",
    status: "blocked_until_closeout_reload",
    willModifyData: false,
    currentActionKey: "reload_closeout_input",
    currentCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    closeoutReload: {
      status: "awaiting_closeout_backfill",
      command: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      packetFile: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json",
      missingCloseoutKeys: output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
    },
    fullTestWindow: {
      status: "blocked",
      canRun: false,
      command: "npm.cmd test",
      missingCloseoutKeys: output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
    },
    postFullTest: {
      targetPacketKey: "production_signoff_packet",
      packetFile: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      requiredDecision: "ready-for-production-signoff",
      missingSignoffKeys: expectedProductionSignoffConditionKeys,
      missingReceiptVisibilityKeys: expectedReceiptVisibilityKeys
    },
    nextAction: "Reload the filled closeout input, confirm missing closeout keys are empty, then run npm.cmd test."
  });
  assert.equal(output.stagingReadinessReviewPacket.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingReadinessReviewPacket.goLiveExecutionEntry.status, "awaiting_closeout_backfill");
  assert.equal(output.stagingReadinessReviewPacket.goLiveExecutionEntry.currentPhase, "full_test_window_entry");
  assert.equal(output.stagingReadinessReviewPacket.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingReadinessReviewPacket.goLiveExecutionEntry.blockerSummary.missingCloseoutKeys.length, 7);
  assert.deepEqual(
    output.stagingReadinessReviewPacket.operatorSteps.map((item) => [item.key, item.status, item.expectedEvidence]),
    [
      ["confirm_closeout_reload", "operator_execute", "Reload the filled closeout input and confirm the closeout evidence targets are filled before entering the full test window."],
      ["review_full_test_window_gate", "blocked", "Verify missing closeout keys are empty, then run npm.cmd test in the reserved full-test window."],
      ["review_production_signoff_gate", "blocked", "Verify every production sign-off condition and all receipt-visibility lanes have redacted evidence before cutover."],
      ["review_launch_day_watch_gate", "blocked", "Confirm production sign-off is ready before starting launch-day watch records."],
      ["review_stabilization_handoff_gate", "blocked", "Confirm launch-day watch records are ready before handing off stabilization ownership."]
    ]
  );
  assert.equal(output.stagingReadinessReviewPacket.nextAction, "Reload filled closeout input, then use this packet to decide whether the full test window can start.");
  assert.equal(output.stagingLaunchDutyArchiveIndex.mode, "staging-launch-duty-archive-index");
  assert.equal(output.stagingLaunchDutyArchiveIndex.status, "awaiting_archive_review");
  assert.equal(output.stagingLaunchDutyArchiveIndex.willModifyData, false);
  assert.equal(output.stagingLaunchDutyArchiveIndex.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.stagingLaunchDutyArchiveIndex.indexFile, "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json");
  assert.deepEqual(output.stagingLaunchDutyArchiveIndex.sourceStatuses, {
    runRecordIndex: "awaiting_evidence_backfill",
    artifactManifest: "awaiting_artifact_generation",
    backupRestorePacket: "awaiting_backup_restore_drill",
    closeoutReloadPacket: "awaiting_closeout_backfill",
    readinessReviewPacket: "blocked_until_closeout_reload",
    productionSignoffPacket: "blocked_until_closeout_reload",
    launchDayWatch: "blocked",
    stabilizationHandoff: "blocked",
    finalPacket: "ready_for_operator_rehearsal"
  });
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveOperatorActionPlan.currentAction.key, "staging_profile");
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveOperatorActionPlan.remainingActionCount, 8);
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.goLiveOperatorActionPlan.phaseSummary.map((item) => [item.phase, item.readyCount, item.blockedCount]),
    [
      ["real_staging_inputs", 1, 3],
      ["full_test_window_entry", 0, 2],
      ["production_signoff", 0, 1],
      ["launch_watch_and_stabilization", 0, 2]
    ]
  );
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.packets.map((item) => [item.key, item.status, item.path]),
    [
      ["run_record_index", "awaiting_evidence_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json"],
      ["artifact_manifest", "awaiting_artifact_generation", "artifacts/staging/PILOT_ALPHA/stable/staging-artifact-manifest.json"],
      ["backup_restore_packet", "awaiting_backup_restore_drill", "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json"],
      ["closeout_reload_packet", "awaiting_closeout_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json"],
      ["readiness_review_packet", "blocked_until_closeout_reload", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json"],
      ["production_signoff_packet", "blocked_until_closeout_reload", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"]
    ]
  );
  assert.deepEqual(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry, {
    mode: "launch-duty-archive-review-execution-entry",
    status: "awaiting_closeout_reload_packet_review",
    willModifyData: false,
    currentPhase: "pre_launch_archive_review",
    currentActionKey: "review_closeout_reload_packet",
    currentPacket: {
      key: "closeout_reload_packet",
      status: "awaiting_closeout_backfill",
      path: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json"
    },
    currentTarget: {
      key: "closeout_reload_packet",
      status: "awaiting_closeout_backfill",
      path: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json"
    },
    packetQueue: [
      ["run_record_index", "awaiting_evidence_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json"],
      ["artifact_manifest", "awaiting_artifact_generation", "artifacts/staging/PILOT_ALPHA/stable/staging-artifact-manifest.json"],
      ["backup_restore_packet", "awaiting_backup_restore_drill", "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json"],
      ["closeout_reload_packet", "awaiting_closeout_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json"],
      ["readiness_review_packet", "blocked_until_closeout_reload", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json"],
      ["production_signoff_packet", "blocked_until_closeout_reload", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"]
    ],
    postSignoffQueue: [],
    watchArtifactQueue: [],
    stabilizationWindowQueue: [],
    firstWaveCloseout: {
      status: "blocked_until_stabilization_owner_handoff",
      currentActionKey: "verify_cutover_watch_records"
    },
    commands: {
      closeoutReload: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      fullTestWindow: "npm.cmd test"
    },
    nextAction: "Open closeout_reload_packet, backfill closeout evidence, then reload the filled closeout input."
  });
  assert.equal(
    output.stagingLaunchDutyArchiveIndex.receiptVisibilityRoutes.launchOpsOverviewStatus,
    output.nextCommands.receiptVisibilitySummaries.launchOpsOverviewStatus
  );
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.watchArtifacts.map((item) => [item.key, item.status, item.path]),
    [
      ["launch_day_watch_summary", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.watchArtifacts.map((item) => [item.key, item.expectedEvidence]),
    [
      ["launch_day_watch_summary", "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
      ["receipt_visibility_snapshot", "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
      ["first_wave_incident_log", "Record first-wave incidents, customer impact, mitigation, owner, and status."],
      ["rollback_signal_review", "Record whether rollback signals were observed, dismissed, or escalated."],
      ["stabilization_owner_handoff", "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."]
    ]
  );
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.signoffTargets.map((item) => [item.key, item.status, item.path]),
    [
      ["production_signoff_packet", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
      ["launch_day_watch_summary", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["launch_duty_archive_index", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"],
      ["stabilization_owner_handoff", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"],
      ["first_wave_closeout", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"]
    ]
  );
  assert.deepEqual(
    output.stagingLaunchDutyArchiveIndex.signoffTargets.map((item) => [item.key, item.receiptOperations, item.expectedEvidence]),
    [
      ["production_signoff_packet", [], "Archive the signed production sign-off packet with full-test status, GO/NO-GO decision, and receipt visibility lanes."],
      ["launch_day_watch_summary", ["record_cutover_walkthrough", "record_launch_day_readiness_review"], "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
      ["receipt_visibility_snapshot", ["record_post_launch_ops_sweep"], "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
      ["first_wave_incident_log", ["record_post_launch_ops_sweep"], "Record first-wave incidents, customer impact, mitigation, owner, and status."],
      ["rollback_signal_review", ["record_rollback_walkthrough", "record_launch_stabilization_review"], "Record whether rollback signals were observed, dismissed, or escalated."],
      ["launch_duty_archive_index", [], "Keep the launch-duty archive index with packet paths, record groups, and current next action."],
      ["stabilization_owner_handoff", ["record_launch_stabilization_review"], "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
      ["first_wave_closeout", ["record_launch_closeout_review"], "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
    ]
  );
  assert.deepEqual(output.stagingLaunchDutyArchiveIndex.stabilizationHandoff, {
    status: "blocked",
    requiredEvidenceKeys: [
      "launch_day_watch_summary",
      "first_wave_incident_log",
      "receipt_visibility_snapshot",
      "rollback_signal_review",
      "stabilization_owner_handoff"
    ],
    watchEvidenceCaptureEntries: output.launchDayWatchPlan.watchEvidenceCaptureEntries,
    handoffWindows: [
      {
        key: "stabilization_owner_handoff",
        label: "T+2h stabilization owner handoff",
        status: "blocked_until_cutover_watch",
        summary: "Hand off launch-day watch summary, incidents, receipt snapshots, and rollback signals to the stabilization owner.",
        receiptOperations: ["record_launch_stabilization_review"],
        expectedEvidence: "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."
      },
      {
        key: "first_wave_closeout",
        label: "T+24h first-wave closeout",
        status: "blocked_until_stabilization_owner_handoff",
        summary: "Close first-wave stabilization with unresolved incident list, customer impact notes, and next-duty owner.",
        receiptOperations: ["record_launch_closeout_review"],
        expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
      }
    ],
    firstWaveCloseoutGate: {
      status: "blocked_until_stabilization_handoff",
      currentHandoffTargetKey: "stabilization_owner_handoff",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      firstWaveCloseoutPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      sourceRecords: [
        ["first_wave_incident_log", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["rollback_signal_review", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "blocked_until_production_signoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ],
      receiptOperations: ["record_launch_closeout_review"],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
      nextAction: "Start launch-day watch and stabilization handoff before first-wave closeout."
    },
    firstWaveCloseoutCaptureEntry: output.stabilizationHandoffPlan.firstWaveCloseoutCaptureEntry,
    firstWaveCloseoutExecutionEntry: output.stabilizationHandoffPlan.firstWaveCloseoutExecutionEntry
  });
  assert.equal(output.stagingLaunchDutyArchiveIndex.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingLaunchDutyArchiveIndex.commands.fullTestWindow, "npm.cmd test");
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveExecutionEntry.mode, "go-live-execution-entry");
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveExecutionEntry.status, "awaiting_closeout_backfill");
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveExecutionEntry.currentActionKey, "route_map_gate_result");
  assert.equal(output.stagingLaunchDutyArchiveIndex.goLiveExecutionEntry.paths.filledCloseoutInputFile, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.stagingLaunchDutyArchiveIndex.nextAction, "Archive the listed launch-duty packets, then use readiness review to decide whether the full test window can start.");
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
      ["run_record_index", "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json", "recommended_default"],
      ["artifact_manifest", "artifacts/staging/PILOT_ALPHA/stable/staging-artifact-manifest.json", "recommended_default"],
      ["backup_restore_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json", "recommended_default"],
      ["closeout_reload_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json", "recommended_default"],
      ["readiness_review_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json", "recommended_default"],
      ["production_signoff_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", "recommended_default"],
      ["launch_duty_archive_index", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json", "recommended_default"],
      ["filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json", "operator_create"],
      ["filled_closeout_draft", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json", "example_only"],
      ["readiness_action_queue", "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md", "operator_generate"],
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
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--run-record-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--artifact-manifest-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifact-manifest\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--backup-restore-packet-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-backup-restore-drill-packet\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--closeout-reload-packet-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-closeout-reload-packet\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--readiness-review-packet-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-readiness-review-packet\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--production-signoff-packet-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--launch-duty-archive-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--filled-closeout-draft-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.draft\.json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--readiness-action-queue-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
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
  assert.match(runbookSteps.run_route_map_gate.summary, /first-batch runtime evidence/);
  assert.equal(
    runbookSteps.run_route_map_gate.expectedEvidence,
    "Record the targeted gate exit status, pass count, and redacted output artifact path."
  );
  assert.deepEqual(runbookSteps.run_backup_restore_drill.commandKeys, [
    "appBackup",
    "postgresBackup",
    "postgresRestoreDryRun",
    "restoreDrillReminder",
    "healthcheck"
  ]);
  assert.equal(runbookSteps.run_backup_restore_drill.closeoutBackfillCommand, output.preflights.recovery.closeoutBackfill.command);
  assert.equal(runbookSteps.run_backup_restore_drill.statusCommand, output.preflights.recovery.closeoutBackfill.statusCommand);
  assert.equal(
    runbookSteps.approve_live_write_smoke.expectedEvidence,
    "Record launch-duty approval owner, timestamp, and confirmation that backup/restore drill evidence is archived before staging writes."
  );
  assert.equal(runbookSteps.run_live_write_smoke.willModifyData, true);
  assert.match(runbookSteps.run_live_write_smoke.command, /launch:smoke:staging/);
  assert.equal(
    runbookSteps.run_live_write_smoke.expectedEvidence,
    "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
  );
  assert.equal(
    runbookSteps.archive_launch_smoke_handoff.expectedEvidence,
    "Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted."
  );
  assert.equal(runbookSteps.record_launch_mainline_evidence.endpoint, output.evidenceActionPlan.endpoint);
  assert.equal(
    runbookSteps.record_launch_mainline_evidence.expectedEvidence,
    "Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action."
  );
  assert.equal(
    runbookSteps.verify_receipt_visibility.expectedEvidence,
    "Verify Launch Review, Launch Smoke, and Launch Ops Overview Status receipt-visibility summaries show the recorded first-wave receipt."
  );
  assert.equal(runbookSteps.backfill_filled_closeout_input.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(
    runbookSteps.backfill_filled_closeout_input.expectedEvidence,
    "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
  );
  assert.equal(runbookSteps.reload_closeout_input.command, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(
    runbookSteps.reload_closeout_input.expectedEvidence,
    "Confirm the reloaded closeout input status, remaining missing fields, and whether the full test window can start."
  );
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
    closeoutInit: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md",
    readinessStatus: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md",
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
    output.finalRehearsalPacket.commands.closeoutInit,
    "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.finalRehearsalPacket.commands.readinessStatus,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.finalRehearsalPacket.commands.closeoutReload,
    "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.deepEqual(
    output.finalRehearsalPacket.localFiles.map((item) => [item.key, item.path, item.status]),
    [
      ["handoff_file", "artifacts/staging/PILOT_ALPHA/stable/staging-rehearsal-handoff.md", "recommended_default"],
      ["closeout_file", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-template.json", "recommended_default"],
      ["run_record_index", "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json", "recommended_default"],
      ["artifact_manifest", "artifacts/staging/PILOT_ALPHA/stable/staging-artifact-manifest.json", "recommended_default"],
      ["backup_restore_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-backup-restore-drill-packet.json", "recommended_default"],
      ["closeout_reload_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json", "recommended_default"],
      ["readiness_review_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json", "recommended_default"],
      ["production_signoff_packet", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", "recommended_default"],
      ["launch_duty_archive_index", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json", "recommended_default"],
      ["filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json", "operator_create"],
      ["filled_closeout_draft", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.draft.json", "example_only"],
      ["readiness_action_queue", "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md", "operator_generate"],
      ["filled_closeout_input_example", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json", "example_only"],
      ["artifact_archive_root", "artifacts/staging/PILOT_ALPHA/stable", "operator_archive"]
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
  assert.deepEqual(
    output.finalRehearsalPacket.postSignoffActionChecklist.map((item) => [item.key, item.status, item.path]),
    [
      ["production_signoff_packet", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
      ["launch_day_watch_summary", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["launch_duty_archive_index", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"],
      ["stabilization_owner_handoff", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"],
      ["first_wave_closeout", "blocked_until_signoff_ready", "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"]
    ]
  );
  assert.deepEqual(
    output.finalRehearsalPacket.postSignoffActionChecklist.map((item) => [item.key, item.receiptOperations, item.expectedEvidence]),
    [
      ["production_signoff_packet", [], "Archive the signed production sign-off packet with full-test status, GO/NO-GO decision, and receipt visibility lanes."],
      ["launch_day_watch_summary", ["record_cutover_walkthrough", "record_launch_day_readiness_review"], "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
      ["receipt_visibility_snapshot", ["record_post_launch_ops_sweep"], "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
      ["first_wave_incident_log", ["record_post_launch_ops_sweep"], "Record first-wave incidents, customer impact, mitigation, owner, and status."],
      ["rollback_signal_review", ["record_rollback_walkthrough", "record_launch_stabilization_review"], "Record whether rollback signals were observed, dismissed, or escalated."],
      ["launch_duty_archive_index", [], "Keep the launch-duty archive index with packet paths, record groups, and current next action."],
      ["stabilization_owner_handoff", ["record_launch_stabilization_review"], "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
      ["first_wave_closeout", ["record_launch_closeout_review"], "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
    ]
  );
  assert.equal(output.finalRehearsalPacket.goLiveCurrentBlocker.key, "staging_profile");
  assert.deepEqual(
    output.finalRehearsalPacket.goLiveActionQueue.slice(0, 4).map((item) => [item.key, item.operatorAction.kind]),
    [
      ["staging_profile", "load_profile"],
      ["required_secret_env", "set_env"],
      ["artifact_output_paths", "provide_artifact_paths"],
      ["filled_closeout_input", "create_file"]
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
    output.operatorExecutionPlan.postSignoffActionChecklist.map((item) => [item.key, item.status]),
    [
      ["production_signoff_packet", "blocked_until_signoff_ready"],
      ["launch_day_watch_summary", "blocked_until_signoff_ready"],
      ["receipt_visibility_snapshot", "blocked_until_signoff_ready"],
      ["first_wave_incident_log", "blocked_until_signoff_ready"],
      ["rollback_signal_review", "blocked_until_signoff_ready"],
      ["launch_duty_archive_index", "blocked_until_signoff_ready"],
      ["stabilization_owner_handoff", "blocked_until_signoff_ready"],
      ["first_wave_closeout", "blocked_until_signoff_ready"]
    ]
  );
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
  assert.match(output.stagingAcceptanceCloseout.acceptanceChecks[0].label, /first-batch runtime evidence/);
  assert.equal(output.stagingAcceptanceCloseout.destinations.launchMainline, output.nextCommands.launchMainline);
  assert.equal(output.stagingAcceptanceCloseout.destinations.developerOps, output.resultBackfillSummary.destinations.developerOps);
  assert.equal(output.stagingAcceptanceCloseout.destinations.evidenceEndpoint, output.evidenceActionPlan.endpoint);
  assert.deepEqual(output.stagingAcceptanceCloseout.destinations.receiptVisibilityDownloads, output.nextCommands.receiptVisibilitySummaries);
  assert.equal(
    output.stagingAcceptanceCloseout.acceptanceChecks.find((item) => item.key === "receipt_visibility_review").downloads.launchOpsOverviewStatus,
    output.nextCommands.receiptVisibilitySummaries.launchOpsOverviewStatus
  );
  assert.match(
    output.stagingAcceptanceCloseout.acceptanceChecks.find((item) => item.key === "receipt_visibility_review").expectedEvidence,
    /Launch Ops Overview Status/
  );
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
    expectedProductionSignoffConditionKeys
  );
  assert.match(
    output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.find((item) => item.key === "launch_ops_overview_status_visible").evidence,
    /Launch Ops Overview Status/
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
    const runRecordFile = join(tempDir, "profile-run-record-index.json");
    const artifactManifestFile = join(tempDir, "profile-artifact-manifest.json");
    const backupRestorePacketFile = join(tempDir, "profile-backup-restore-drill-packet.json");
    const closeoutReloadPacketFile = join(tempDir, "profile-closeout-reload-packet.json");
    const readinessReviewPacketFile = join(tempDir, "profile-readiness-review-packet.json");
    const productionSignoffPacketFile = join(tempDir, "profile-production-signoff-packet.json");
    const launchDutyArchiveIndexFile = join(tempDir, "profile-launch-duty-archive-index.json");
    const filledCloseoutDraftFile = join(tempDir, "profile-filled-closeout-input.draft.json");
    const readinessActionQueueFile = join(tempDir, "profile-readiness-action-queue.md");
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
      postgresBackupDir: "/var/lib/rocksolid/profile-postgres-backups",
      readinessActionQueueFile
    }, null, 2));

    const result = runRehearsal([
      "--profile-file",
      profileFile,
      "--channel",
      "stable",
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--backup-restore-packet-file",
      backupRestorePacketFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--production-signoff-packet-file",
      productionSignoffPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
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
        "readinessActionQueueFile",
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
      "closeoutFile",
      "runRecordFile",
      "artifactManifestFile",
      "backupRestorePacketFile",
      "closeoutReloadPacketFile",
      "readinessReviewPacketFile",
      "productionSignoffPacketFile",
      "launchDutyArchiveIndexFile",
      "filledCloseoutDraftFile"
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
    assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--readiness-action-queue-file /);
    assert.match(output.stagingEnvironmentBinding.dryRunCommand, /profile-readiness-action-queue\.md/);
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
        ["run_record_index", runRecordFile, "pending_write"],
        ["artifact_manifest", artifactManifestFile, "pending_write"],
        ["backup_restore_packet", backupRestorePacketFile, "pending_write"],
        ["closeout_reload_packet", closeoutReloadPacketFile, "pending_write"],
        ["readiness_review_packet", readinessReviewPacketFile, "pending_write"],
        ["production_signoff_packet", productionSignoffPacketFile, "pending_write"],
        ["launch_duty_archive_index", launchDutyArchiveIndexFile, "pending_write"],
        ["filled_closeout_input", "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json", "operator_create"],
        ["filled_closeout_draft", filledCloseoutDraftFile, "pending_write"],
        ["readiness_action_queue", readinessActionQueueFile, "operator_generate"],
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
    assert.equal(
      output.stagingProfileOperatorPreflight.commands.closeoutInit,
      `npm.cmd run staging:closeout:init -- --draft-file ${filledCloseoutDraftFile} --output-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json --actions-file ${readinessActionQueueFile}`
    );
    assert.equal(
      output.stagingProfileOperatorPreflight.commands.readinessStatus,
      `npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json --actions-file ${readinessActionQueueFile}`
    );
    assert.equal(output.stagingProfileOperatorPreflight.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.mode, "real-staging-run-focus");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.status, "blocked_until_secret_env");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.canRunDryRun, true);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.canRunLiveWriteSmoke, true);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.canRecordEvidence, false);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.currentAction.key, "set_required_secret_env");
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.currentAction.envKeys, ["RSL_DEVELOPER_BEARER_TOKEN"]);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.paths.artifactArchiveRoot, "artifacts/staging/PROFILE_PRODUCT/stable");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.paths.filledCloseoutInputFile, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.paths.readinessActionQueueFile, readinessActionQueueFile);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.commands.stagingDryRun, output.stagingEnvironmentBinding.dryRunCommand);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.commands.closeoutInit, output.stagingProfileOperatorPreflight.commands.closeoutInit);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.commands.readinessStatus, output.stagingProfileOperatorPreflight.commands.readinessStatus);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.commands.closeoutReload, output.stagingProfileOperatorPreflight.commands.closeoutReload);
    assert.equal(output.stagingRehearsalExecutionSummary.commands.closeoutInit, output.stagingProfileOperatorPreflight.commands.closeoutInit);
    assert.equal(output.stagingRehearsalExecutionSummary.commands.readinessStatus, output.stagingProfileOperatorPreflight.commands.readinessStatus);
    assert.equal(output.stagingRehearsalExecutionSummary.mode, "staging-rehearsal-execution-summary");
    assert.equal(output.stagingRehearsalExecutionSummary.status, "blocked_until_secret_env");
    assert.deepEqual(output.stagingRehearsalExecutionSummary.sourceStatuses, {
      profilePreflight: "blocked_until_secret_env",
      executionRunbook: "ready_for_real_staging_dry_run",
      closeoutReview: "not_loaded",
      readinessTransition: "blocked_until_closeout_reload",
      finalPacket: "ready_for_operator_rehearsal"
    });
    assert.deepEqual(output.stagingRehearsalExecutionSummary.operatorFocus.missingSecretEnv, ["RSL_DEVELOPER_BEARER_TOKEN"]);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.closeoutMissingFieldCount, 7);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.canRunDryRun, true);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.canRunLiveWriteSmoke, true);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.canRecordEvidence, false);
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.checks.map((item) => [item.key, item.status]),
      [
        ["staging_profile", "ready"],
        ["required_secret_env", "missing"],
        ["artifact_output_paths", "ready"],
        ["artifact_archive_root", "ready"],
        ["filled_closeout_input", "not_loaded"]
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.status, "blocked_until_secret_env");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.readyCheckCount, 3);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.blockedCheckCount, 2);
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.checks.map((item) => [item.key, item.status]),
      [
        ["staging_profile", "ready"],
        ["required_secret_env", "missing"],
        ["artifact_output_paths", "ready"],
        ["artifact_archive_root", "ready"],
        ["filled_closeout_input", "not_loaded"],
        ["full_test_window", "blocked"],
        ["production_signoff", "blocked"],
        ["launch_day_watch", "blocked"],
        ["stabilization_handoff", "blocked"]
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.status, "blocked_until_real_staging_inputs");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.readyCheckCount, 3);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.blockedCheckCount, 6);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.scriptReadinessPercent, 33);
    const goLiveProgress = output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress;
    assert.deepEqual(
      goLiveProgress.blockedQueue.map((item) => item.key),
      [
        "required_secret_env",
        "filled_closeout_input",
        "full_test_window",
        "production_signoff",
        "launch_day_watch",
        "stabilization_handoff"
      ]
    );
    assert.equal(goLiveProgress.currentBlocker.key, "required_secret_env");
    assert.equal(goLiveProgress.currentBlocker.operatorAction.kind, "set_env");
    assert.deepEqual(goLiveProgress.currentBlocker.operatorAction.envKeys, ["RSL_DEVELOPER_BEARER_TOKEN"]);
    assert.equal(goLiveProgress.blockedQueue.find((item) => item.key === "filled_closeout_input").operatorAction.artifactPath, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(goLiveProgress.blockedQueue.find((item) => item.key === "filled_closeout_input").operatorAction.command, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(goLiveProgress.blockedQueue.find((item) => item.key === "full_test_window").operatorAction.command, "npm.cmd test");
    assert.equal(goLiveProgress.blockedQueue.find((item) => item.key === "production_signoff").operatorAction.artifactPath, productionSignoffPacketFile);
    assert.deepEqual(
      goLiveProgress.operatorActionQueue.map((item) => [item.key, item.operatorAction.kind]),
      [
        ["required_secret_env", "set_env"],
        ["filled_closeout_input", "create_file"],
        ["full_test_window", "run_command"],
        ["production_signoff", "backfill_artifact"],
        ["launch_day_watch", "record_artifact"],
        ["stabilization_handoff", "record_handoff"]
      ]
    );
    assert.equal(goLiveProgress.operatorActionPlan.mode, "go-live-operator-action-plan");
    assert.equal(goLiveProgress.operatorActionPlan.status, "blocked_until_real_staging_inputs");
    assert.equal(goLiveProgress.operatorActionPlan.remainingActionCount, 6);
    assert.equal(goLiveProgress.operatorActionPlan.currentAction.key, "required_secret_env");
    assert.equal(goLiveProgress.operatorActionPlan.currentAction.phase, "real_staging_inputs");
    assert.deepEqual(
      goLiveProgress.operatorActionPlan.actions.slice(0, 5).map((item) => [item.sequence, item.key, item.phase, item.status, item.needsOperatorAction]),
      [
        [1, "staging_profile", "real_staging_inputs", "ready", false],
        [2, "required_secret_env", "real_staging_inputs", "missing", true],
        [3, "artifact_output_paths", "real_staging_inputs", "ready", false],
        [4, "artifact_archive_root", "real_staging_inputs", "ready", false],
        [5, "filled_closeout_input", "full_test_window_entry", "not_loaded", true]
      ]
    );
    assert.deepEqual(
      goLiveProgress.operatorActionPlan.phaseSummary.map((item) => [item.phase, item.readyCount, item.blockedCount]),
      [
        ["real_staging_inputs", 3, 1],
        ["full_test_window_entry", 0, 2],
        ["production_signoff", 0, 1],
        ["launch_watch_and_stabilization", 0, 2]
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.status, "blocked_until_real_staging_inputs");
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.remainingBlockers.slice(0, 3).map((item) => item.key),
      ["missing_secret_env", "closeout_input_not_ready", "production_signoff_not_ready"]
    );
    assert.equal(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.nextAction,
      "Set missing secret env, reload filled closeout input, then continue toward production sign-off."
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.nextPlan.map((item) => item.key),
      [
        "set_missing_secret_env",
        "backfill_and_reload_closeout_input",
        "run_full_test_window",
        "backfill_production_signoff",
        "start_launch_day_watch"
      ]
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.blockingReasons.map((item) => [item.key, item.status]),
      [
        ["missing_secret_env", "blocked"],
        ["closeout_input", "not_loaded"],
        ["readiness_transition", "blocked_until_closeout_reload"]
      ]
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.orderedNextActions.slice(0, 4),
      [
        "set_missing_secret_env",
        "prepare_secret_env",
        "generate_rehearsal_outputs",
        "run_route_map_gate"
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.commands.stagingDryRun, output.stagingEnvironmentBinding.dryRunCommand);
    assert.equal(output.stagingRehearsalExecutionSummary.commands.closeoutReload, output.stagingProfileOperatorPreflight.commands.closeoutReload);
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
    assert.match(handoff, /Profile keys: adminUsername, appBackupDir, baseUrl, channel, developerUsername, postgresBackupDir, productCode, readinessActionQueueFile, storageProfile, targetEnvFile, targetOs/);
    assert.match(handoff, /## Staging Profile Launch Plan/);
    assert.match(handoff, /Profile launch plan status: ready_for_profile_driven_rehearsal/);
    assert.match(handoff, /CLI override keys: channel, handoffFile, closeoutFile, runRecordFile, artifactManifestFile, backupRestorePacketFile, closeoutReloadPacketFile, readinessReviewPacketFile, productionSignoffPacketFile, launchDutyArchiveIndexFile, filledCloseoutDraftFile/);
    assert.match(handoff, /Required output files: handoffFile, closeoutFile, runRecordFile, artifactManifestFile, backupRestorePacketFile, closeoutReloadPacketFile, readinessReviewPacketFile, productionSignoffPacketFile, launchDutyArchiveIndexFile, filledCloseoutDraftFile/);
    assert.match(handoff, /Closeout init: `npm\.cmd run staging:closeout:init -- --draft-file [^`]*profile-filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(handoff, /Readiness status: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(handoff, /RSL_DEVELOPER_BEARER_TOKEN: missing before_evidence_recording/);
    assert.match(handoff, /## Staging Profile Operator Preflight/);
    assert.match(handoff, /Profile preflight status: blocked_until_secret_env/);
    assert.match(handoff, /Missing secret env: RSL_DEVELOPER_BEARER_TOKEN/);
    assert.match(handoff, /Can run dry run: yes/);
    assert.match(handoff, /Can record evidence: no/);
    assert.match(handoff, /Real staging run focus: blocked_until_secret_env \(dryRun=yes, liveWriteSmoke=yes, evidence=no\)/);
    assert.match(handoff, /Real staging current action: set_required_secret_env \(env=RSL_DEVELOPER_BEARER_TOKEN\)/);
    assert.match(handoff, /Real staging archive root: artifacts\/staging\/PROFILE_PRODUCT\/stable/);
    assert.match(handoff, /Real staging closeout init: `npm\.cmd run staging:closeout:init -- --draft-file [^`]*profile-filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(handoff, /Real staging readiness status: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(handoff, /Real staging closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /## Staging Rehearsal Execution Summary/);
    assert.match(handoff, /Execution summary status: blocked_until_secret_env/);
    assert.match(handoff, /Closeout review: not_loaded \(missing=7\)/);
    assert.match(handoff, /Backfill manifest: awaiting_profile_driven_results/);
    assert.match(handoff, /backup_restore_drill_result: run_backup_restore_drill -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/backup-restore-drill\.txt/);
    assert.match(handoff, /launch_mainline_evidence_receipts: record_launch_mainline_evidence -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/launch-mainline-evidence-receipts\.json/);
    const template = JSON.parse(readFileSync(closeoutFile, "utf8"));
    assert.deepEqual(template.stagingProfile, output.stagingProfile);
    assert.deepEqual(template.stagingProfileLaunchPlan, output.stagingProfileLaunchPlan);
    assert.deepEqual(template.stagingProfileOperatorPreflight, output.stagingProfileOperatorPreflight);
    assert.deepEqual(template.stagingRehearsalExecutionSummary, output.stagingRehearsalExecutionSummary);
    assert.equal(template.operatorExecutionPlan.realStagingRunFocus.currentAction.key, "set_required_secret_env");
    assert.equal(template.operatorExecutionPlan.realStagingRunFocus.canRunDryRun, true);
    assert.deepEqual(template.operatorExecutionPlan.outputWriteSummary, output.operatorExecutionPlan.outputWriteSummary);
    assert.deepEqual(
      template.operatorExecutionPlan.realStagingRunFocus.executionEntry.preflight.outputBundle,
      output.operatorExecutionPlan.realStagingRunFocus.executionEntry.preflight.outputBundle
    );
    assert.deepEqual(template.stagingRehearsalRunRecordIndex, output.stagingRehearsalRunRecordIndex);
    assert.equal(output.runRecordFile.path, runRecordFile);
    assert.equal(output.runRecordFile.written, true);
    assert.equal(existsSync(runRecordFile), true);
    assert.deepEqual(JSON.parse(readFileSync(runRecordFile, "utf8")), output.stagingRehearsalRunRecordIndex);
    assert.deepEqual(template.stagingArtifactManifest, output.stagingArtifactManifest);
    assert.equal(output.artifactManifestFile.path, artifactManifestFile);
    assert.equal(output.artifactManifestFile.written, true);
    assert.equal(existsSync(artifactManifestFile), true);
    assert.deepEqual(JSON.parse(readFileSync(artifactManifestFile, "utf8")), output.stagingArtifactManifest);
    assert.deepEqual(template.stagingBackupRestoreDrillPacket, output.stagingBackupRestoreDrillPacket);
    assert.equal(output.backupRestorePacketFile.path, backupRestorePacketFile);
    assert.equal(output.backupRestorePacketFile.written, true);
    assert.equal(existsSync(backupRestorePacketFile), true);
    assert.deepEqual(JSON.parse(readFileSync(backupRestorePacketFile, "utf8")), output.stagingBackupRestoreDrillPacket);
    assert.equal(output.stagingBackupRestoreDrillPacket.packetFile, backupRestorePacketFile);
    assert.equal(output.stagingBackupRestoreDrillPacket.artifactPath, "artifacts/staging/PROFILE_PRODUCT/stable/backup-restore-drill.txt");
    assert.deepEqual(output.stagingBackupRestoreDrillPacket.receiptOperations, ["record_recovery_drill", "record_backup_verification"]);
    assert.deepEqual(template.stagingCloseoutReloadPacket, output.stagingCloseoutReloadPacket);
    assert.equal(output.closeoutReloadPacketFile.path, closeoutReloadPacketFile);
    assert.equal(output.closeoutReloadPacketFile.written, true);
    assert.equal(existsSync(closeoutReloadPacketFile), true);
    assert.deepEqual(JSON.parse(readFileSync(closeoutReloadPacketFile, "utf8")), output.stagingCloseoutReloadPacket);
    assert.equal(output.stagingCloseoutReloadPacket.paths.packetFile, closeoutReloadPacketFile);
    assert.equal(output.stagingCloseoutReloadPacket.paths.filledCloseoutDraftFile, filledCloseoutDraftFile);
    assert.equal(output.stagingCloseoutReloadPacket.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.deepEqual(template.stagingReadinessReviewPacket, output.stagingReadinessReviewPacket);
    assert.equal(output.readinessReviewPacketFile.path, readinessReviewPacketFile);
    assert.equal(output.readinessReviewPacketFile.written, true);
    assert.equal(existsSync(readinessReviewPacketFile), true);
    assert.deepEqual(JSON.parse(readFileSync(readinessReviewPacketFile, "utf8")), output.stagingReadinessReviewPacket);
    assert.equal(output.stagingReadinessReviewPacket.packetFile, readinessReviewPacketFile);
    assert.equal(output.stagingReadinessReviewPacket.sourceStatuses.closeoutReloadPacket, "awaiting_closeout_backfill");
    assert.equal(output.stagingReadinessReviewPacket.gates.find((item) => item.key === "production_signoff").requiredDecision, "ready-for-production-signoff");
    assert.deepEqual(template.stagingProductionSignoffPacket, output.stagingProductionSignoffPacket);
    assert.equal(output.productionSignoffPacketFile.path, productionSignoffPacketFile);
    assert.equal(output.productionSignoffPacketFile.written, true);
    assert.equal(existsSync(productionSignoffPacketFile), true);
    assert.deepEqual(JSON.parse(readFileSync(productionSignoffPacketFile, "utf8")), output.stagingProductionSignoffPacket);
    assert.equal(output.stagingProductionSignoffPacket.packetFile, productionSignoffPacketFile);
    assert.equal(output.stagingProductionSignoffPacket.sourceStatuses.readinessReviewPacket, "blocked_until_closeout_reload");
    assert.deepEqual(template.stagingLaunchDutyArchiveIndex, output.stagingLaunchDutyArchiveIndex);
    assert.equal(output.launchDutyArchiveIndexFile.path, launchDutyArchiveIndexFile);
    assert.equal(output.launchDutyArchiveIndexFile.written, true);
    assert.equal(existsSync(launchDutyArchiveIndexFile), true);
    assert.deepEqual(JSON.parse(readFileSync(launchDutyArchiveIndexFile, "utf8")), output.stagingLaunchDutyArchiveIndex);
    assert.equal(output.stagingLaunchDutyArchiveIndex.indexFile, launchDutyArchiveIndexFile);
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.packets.map((item) => item.key),
      ["run_record_index", "artifact_manifest", "backup_restore_packet", "closeout_reload_packet", "readiness_review_packet", "production_signoff_packet"]
    );
    assert.equal(output.filledCloseoutDraftFile.path, filledCloseoutDraftFile);
    assert.equal(output.filledCloseoutDraftFile.written, true);
    assert.equal(existsSync(filledCloseoutDraftFile), true);
    assert.deepEqual(JSON.parse(readFileSync(filledCloseoutDraftFile, "utf8")), output.filledCloseoutInputDraft);
    assert.equal(output.filledCloseoutInputDraft.mode, "staging-closeout-input-draft");
    assert.equal(output.filledCloseoutInputDraft.status, "draft_replace_before_use");
    assert.equal(output.filledCloseoutInputDraft.exampleOnly, true);
    assert.equal(output.filledCloseoutInputDraft.source, "stagingProfileLaunchPlan.backfillManifest");
    assert.equal(output.filledCloseoutInputDraft.copyTo, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.filledCloseoutInputDraft.saveAs, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.draft.json");
    assert.deepEqual(output.operatorExecutionPlan.outputWriteSummary, {
      status: "written",
      willModifyData: false,
      outputFileCount: 10,
      writtenFileCount: 10,
      pendingWriteCount: 0,
      missingPathCount: 0,
      archiveEntrypoint: {
        key: "launch_duty_archive_index",
        status: "written",
        path: launchDutyArchiveIndexFile
      },
      currentReviewTarget: {
        key: "launch_duty_archive_index",
        status: "written",
        path: launchDutyArchiveIndexFile
      },
      files: [
        ["handoff_file", "written", handoffFile],
        ["closeout_file", "written", closeoutFile],
        ["run_record_index", "written", runRecordFile],
        ["artifact_manifest", "written", artifactManifestFile],
        ["backup_restore_packet", "written", backupRestorePacketFile],
        ["closeout_reload_packet", "written", closeoutReloadPacketFile],
        ["readiness_review_packet", "written", readinessReviewPacketFile],
        ["production_signoff_packet", "written", productionSignoffPacketFile],
        ["launch_duty_archive_index", "written", launchDutyArchiveIndexFile],
        ["filled_closeout_draft", "written", filledCloseoutDraftFile]
      ],
      nextAction: "Open the launch-duty archive index, then continue closeout reload and launch-duty packet focus from the generated handoff."
    });
    assert.deepEqual(output.stagingOutputWriteSummary, output.operatorExecutionPlan.outputWriteSummary);
    assert.match(handoff, /Output write summary: written \(written=10\/10, pending=0\)/);
    assert.match(handoff, new RegExp(`Output archive entrypoint: launch_duty_archive_index \\(written\\) -> ${launchDutyArchiveIndexFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.match(handoff, /Output write next action: Open the launch-duty archive index, then continue closeout reload and launch-duty packet focus from the generated handoff\./);
    assert.deepEqual(
      output.filledCloseoutInputDraft.operatorSteps.map((item) => [item.key, item.status]),
      [
        ["review_draft_field_sources", "operator_review"],
        ["copy_draft_to_filled_closeout_input", "operator_execute"],
        ["replace_placeholder_values", "operator_backfill"],
        ["remove_example_only_and_reload", "operator_execute"],
        ["review_full_test_window_gate", "blocked_until_closeout_reload"]
      ]
    );
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

test("staging rehearsal plain output labels the real staging launch-duty chain for operators", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-plain-output-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    const handoffFile = join(tempDir, "profile-handoff.md");
    const closeoutFile = join(tempDir, "profile-closeout.json");
    const runRecordFile = join(tempDir, "profile-run-record-index.json");
    const artifactManifestFile = join(tempDir, "profile-artifact-manifest.json");
    const backupRestorePacketFile = join(tempDir, "profile-backup-restore-drill-packet.json");
    const closeoutReloadPacketFile = join(tempDir, "profile-closeout-reload-packet.json");
    const readinessReviewPacketFile = join(tempDir, "profile-readiness-review-packet.json");
    const productionSignoffPacketFile = join(tempDir, "profile-production-signoff-packet.json");
    const launchDutyArchiveIndexFile = join(tempDir, "profile-launch-duty-archive-index.json");
    const filledCloseoutDraftFile = join(tempDir, "profile-filled-closeout-input.draft.json");
    const readinessActionQueueFile = join(tempDir, "profile-readiness-action-queue.md");
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
      postgresBackupDir: "/var/lib/rocksolid/profile-postgres-backups",
      readinessActionQueueFile
    }, null, 2));

    const result = runRehearsalPlain([
      "--profile-file",
      profileFile,
      "--channel",
      "stable",
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--backup-restore-packet-file",
      backupRestorePacketFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--production-signoff-packet-file",
      productionSignoffPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "ProfileAdmin123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "ProfileDeveloper123!"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Current command: `npm\.cmd(?: --silent)? run launch:smoke:staging/);
    assert.match(result.stdout, /Route-map gate: `npm\.cmd run launch:route-map-gate`/);
    assert.match(result.stdout, /Launch Mainline: `https:\/\/profile-staging\.example\.com\/developer\/launch-mainline\?productCode=PROFILE_PRODUCT&channel=stable&source=staging-rehearsal&handoff=first-wave`/);
    assert.match(result.stdout, /Environment next action: Complete the operator_confirm and operator_execute items before running the live-write staging smoke command\./);
    assert.match(result.stdout, /Real staging current action: set_required_secret_env \(env=RSL_DEVELOPER_BEARER_TOKEN\)/);
    assert.match(result.stdout, /Real staging run focus: blocked_until_secret_env \(dryRun=yes, liveWriteSmoke=yes, evidence=no\)/);
    assert.match(result.stdout, /Real staging execution entry: blocked \(action=set_required_secret_env, outputs=written 10\/10\)/);
    assert.match(result.stdout, /Real staging execution current command: `npm\.cmd run staging:rehearsal -- --json --base-url https:\/\/profile-staging\.example\.com --product-code PROFILE_PRODUCT --channel stable/);
    assert.match(result.stdout, /Real staging execution first backfill: route_map_gate_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Real staging execution closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Live-write smoke result capture entry: ready_for_live_write_smoke_result_capture \(action=run_live_write_smoke, target=live_write_smoke_result\)/);
    assert.match(result.stdout, /Live-write smoke result backfill: pending_operator_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/live-write-smoke-output\.json \(closeout=artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json\)/);
    assert.match(result.stdout, /Live-write smoke result receipts: record_launch_rehearsal_run:pending_operator_receipt/);
    assert.match(result.stdout, /Backup\/restore execution entry: awaiting_backup_restore_drill \(action=run_app_backup, target=backup_restore_drill_result\)/);
    assert.match(result.stdout, /Backup\/restore execution command sequence: run_app_backup:operator_execute, run_postgres_backup:operator_execute, run_postgres_restore_dry_run:operator_execute, run_restore_healthcheck:operator_execute/);
    assert.match(result.stdout, /Backup\/restore execution receipts: record_recovery_drill:pending_operator_receipt, record_backup_verification:pending_operator_receipt/);
    assert.match(result.stdout, /Backup\/restore result backfill: pending_operator_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/backup-restore-drill\.txt \(closeout=artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json\)/);
    assert.match(result.stdout, /Backup\/restore closeout backfill command: `npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PROFILE_PRODUCT\/stable\/backup-restore-drill\.txt --receipt-id <recovery-drill-receipt-id> --receipt-id <backup-verification-receipt-id> --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(result.stdout, /Backup\/restore execution reload: blocked_until_backup_restore_backfill -> `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Closeout init: `npm\.cmd run staging:closeout:init -- --draft-file [^`]*profile-filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(result.stdout, /Readiness status: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(result.stdout, /Closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Output write summary: written \(written=10\/10, pending=0\)/);
    assert.match(result.stdout, /Output archive entrypoint: launch_duty_archive_index \(written\) -> .*profile-launch-duty-archive-index\.json/);
    assert.match(result.stdout, /Output write next action: Open the launch-duty archive index, then continue closeout reload and launch-duty packet focus from the generated handoff\./);
    assert.match(result.stdout, /Run record index status: awaiting_evidence_backfill \(records=13\)/);
    assert.match(result.stdout, /Run record closeout progress: missing=7, filled=0/);
    assert.match(result.stdout, /Run record groups: pre_full_test_closeout:awaiting_operator_evidence:7, production_signoff:blocked_until_full_test_window:7, launch_day_watch_and_stabilization:blocked_until_production_signoff:6/);
    assert.match(result.stdout, /Run record next action: Collect the missing pre-full-test record artifacts, backfill filled-closeout-input\.json, then reload closeout input\./);
    assert.match(result.stdout, /Artifact manifest status: awaiting_artifact_generation \(files=14\)/);
    assert.match(result.stdout, /Artifact manifest source statuses: profilePreflight=blocked_until_secret_env, executionSummary=blocked_until_secret_env, runRecordIndex=awaiting_evidence_backfill, finalPacket=ready_for_operator_rehearsal/);
    assert.match(result.stdout, /Artifact manifest key files: run_record_index=.*profile-run-record-index\.json; artifact_manifest=.*profile-artifact-manifest\.json; backup_restore_packet=.*profile-backup-restore-drill-packet\.json; closeout_reload_packet=.*profile-closeout-reload-packet\.json; readiness_review_packet=.*profile-readiness-review-packet\.json; production_signoff_packet=.*profile-production-signoff-packet\.json; launch_duty_archive_index=.*profile-launch-duty-archive-index\.json/);
    assert.match(result.stdout, /Artifact manifest next action: Generate and archive the listed rehearsal artifacts, then fill closeout evidence from the draft before reloading closeout input\./);
    assert.match(result.stdout, /Launch-duty packet focus: closeout_reload_packet \(awaiting_closeout_backfill\)/);
    assert.match(result.stdout, /Launch-duty current packet path: .*profile-closeout-reload-packet\.json/);
    assert.match(result.stdout, /Launch-duty archive index: .*profile-launch-duty-archive-index\.json/);
    assert.match(result.stdout, /Launch-duty packet sequence: run_record_index -> artifact_manifest -> backup_restore_packet -> closeout_reload_packet -> readiness_review_packet -> production_signoff_packet/);
    assert.match(result.stdout, /Launch-duty packet closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Launch-duty packet next action: Backfill the real filled closeout input, reload it, then review full-test-window readiness before running npm\.cmd test\./);
    assert.match(result.stdout, /Archive review execution entry: awaiting_closeout_reload_packet_review \(phase=pre_launch_archive_review, action=review_closeout_reload_packet, target=closeout_reload_packet\)/);
    assert.match(result.stdout, /Archive review current packet: closeout_reload_packet -> .*profile-closeout-reload-packet\.json/);
    assert.match(result.stdout, /Archive review packet queue: run_record_index:awaiting_evidence_backfill, artifact_manifest:awaiting_artifact_generation, backup_restore_packet:awaiting_backup_restore_drill, closeout_reload_packet:awaiting_closeout_backfill, readiness_review_packet:blocked_until_closeout_reload, production_signoff_packet:blocked_until_closeout_reload/);
    assert.match(result.stdout, /Archive review closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Archive review next action: Open closeout_reload_packet, backfill closeout evidence, then reload the filled closeout input\./);
    assert.match(result.stdout, /Closeout backfill focus: awaiting_closeout_backfill \(missing=7, current=route_map_gate_result\)/);
    assert.match(result.stdout, /Closeout reload execution entry: awaiting_backfill \(current=route_map_gate_result, queue=7\/7\)/);
    assert.match(result.stdout, /Closeout reload first queue item: route_map_gate_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Closeout reload post-reload review: readiness_review_packet \(fullTest=no, command=npm\.cmd test\)/);
    assert.match(result.stdout, /Post-live-write closeout result capture entries: 3/);
    assert.match(result.stdout, /launch_smoke_handoff: pending_operator_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/launch-smoke-handoff\.json/);
    assert.match(result.stdout, /launch_mainline_evidence_receipts: pending_operator_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/launch-mainline-evidence-receipts\.json/);
    assert.match(result.stdout, /receipt_visibility_review: pending_operator_result -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/receipt-visibility-review\.txt/);
    assert.match(result.stdout, /Operator go\/no-go result capture entry: pending_operator_decision \(decision=-, action=backfill_filled_closeout_input\) -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/operator-go-no-go\.md/);
    assert.match(result.stdout, /Operator go\/no-go allowed decisions: ready-for-full-test-window, hold, rollback-follow-up/);
    assert.match(result.stdout, /Operator go\/no-go reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Current closeout source step: run_route_map_gate/);
    assert.match(result.stdout, /Current closeout artifact: artifacts\/staging\/PROFILE_PRODUCT\/stable\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Current closeout backfill command: `npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PROFILE_PRODUCT\/stable\/route-map-gate-output\.txt --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(result.stdout, /Current closeout status command: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PROFILE_PRODUCT\/stable\/filled-closeout-input\.json --actions-file [^`]*profile-readiness-action-queue\.md`/);
    assert.match(result.stdout, /Closeout missing keys: route_map_gate_result, backup_restore_drill_result, live_write_smoke_result, launch_smoke_handoff, launch_mainline_evidence_receipts, receipt_visibility_review, operator_go_no_go/);
    assert.match(result.stdout, /Closeout focus next action: Backfill route_map_gate_result, then rerun staging:readiness:status and staging:rehearsal\./);
    assert.match(result.stdout, /Launch Review summary: `https:\/\/profile-staging\.example\.com\/api\/developer\/launch-review\/download\?productCode=PROFILE_PRODUCT&channel=stable&source=launch-smoke&handoff=first-wave&format=summary`/);
    assert.match(result.stdout, /Launch Smoke summary: `https:\/\/profile-staging\.example\.com\/api\/developer\/launch-smoke-kit\/download\?productCode=PROFILE_PRODUCT&channel=stable&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary`/);
    assert.match(result.stdout, /Launch Ops overview status: `https:\/\/profile-staging\.example\.com\/api\/developer\/ops\/export\/download\?productCode=PROFILE_PRODUCT&format=launch-operations-overview-status&limit=20`/);
    assert.doesNotMatch(result.stdout, /ProfileAdmin123!|ProfileDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal plain output prints launch-day watch operator handoff after signoff is ready", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-launch-duty-plain-"));
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
    const signoffConditions = expectedProductionSignoffConditionKeys.map((key) => ({
      key,
      status: "filled",
      value: key === "full_test_window_passed"
        ? { result: "pass", command: "npm.cmd test", failureCount: 0 }
        : { result: "confirmed" }
    }));
    writeFileSync(closeoutInputFile, `${JSON.stringify({
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
        },
        launchOpsOverviewStatus: {
          status: "filled",
          value: "visible"
        }
      },
      productionSignoff: {
        decision: "ready-for-production-signoff",
        conditions: signoffConditions
      }
    }, null, 2)}\n`, "utf8");

    const result = runRehearsalPlain([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Go-live execution entry: ready_for_launch_day_watch \(phase=launch_watch_and_stabilization, source=launchDutyPacketFocus, action=archive_production_signoff\)/);
    assert.match(result.stdout, /Go-live execution blockers: closeout=-, signoff=-, receipts=-/);
    assert.match(result.stdout, /Go-live launch-day watch records: launch_day_watch_summary=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; receipt_visibility_snapshot=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt; first_wave_incident_log=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(result.stdout, /Go-live launch-day evidence receipts: launch_day_watch_summary=record_cutover_walkthrough:pending_operator_receipt, launch_day_watch_summary=record_launch_day_readiness_review:pending_operator_receipt/);
    assert.match(result.stdout, /Go-live execution next action: Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff\./);
    assert.match(result.stdout, /Launch duty current action: archive_production_signoff \(stage=launch_day_watch_entry, source=launchDutyPacketFocus\)/);
    assert.match(result.stdout, /Launch duty current packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Launch duty evidence inputs: production_signoff_packet=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json; launch_day_watch_summary=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(result.stdout, /Launch duty archive trace: group=launch_day_watch_and_stabilization, runRecord=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json, archiveIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(result.stdout, /Launch duty follow-up watch action: launch_day_watch_summary \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(result.stdout, /Launch duty follow-up stabilization target: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(result.stdout, /Launch duty follow-up stabilization sources: launch_day_watch_summary=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; first_wave_incident_log=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; receipt_visibility_snapshot=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt; rollback_signal_review=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(result.stdout, /Launch duty follow-up first-wave closeout: first_wave_closeout -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch duty follow-up first-wave receipts: first_wave_closeout=record_launch_closeout_review:pending_operator_receipt/);
    assert.match(result.stdout, /Launch duty stabilization next action: Record stabilization owner handoff, then close first-wave stabilization\./);
    assert.match(result.stdout, /Launch duty first-wave closeout next action: Record first-wave closeout decision, unresolved incidents, customer impact, next-duty owner, and receipt ID\./);
    assert.match(result.stdout, /Launch duty watch evidence next action: Record launch_day_watch_summary, attach receipt IDs, then continue launch-day watch evidence before stabilization handoff\./);
    assert.match(result.stdout, /Launch duty next action: Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff\./);
    assert.match(result.stdout, /Post-signoff action checklist:/);
    assert.match(result.stdout, /production_signoff_packet: archive_before_cutover \(action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /launch_day_watch_summary: record_during_cutover_watch \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*receiptOperations: record_cutover_walkthrough, record_launch_day_readiness_review/);
    assert.match(result.stdout, /first_wave_closeout: close_after_stabilization_handoff \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*receiptOperations: record_launch_closeout_review/);
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal plain output prints production signoff evidence handoff after closeout is ready", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-signoff-plain-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-ready.json");
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
    writeFileSync(closeoutInputFile, `${JSON.stringify({
      mode: "staging-closeout-template",
      decision: "ready-for-full-test-window",
      acceptanceFields
    }, null, 2)}\n`, "utf8");

    const result = runRehearsalPlain([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Readiness review packet: ready_for_full_test_window \(fullTest=yes, signoff=no\)/);
    assert.match(result.stdout, /Readiness review packet file: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-readiness-review-packet\.json/);
    assert.match(result.stdout, /Readiness review closeout reload: ready_for_full_test_window -> `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`/);
    assert.match(result.stdout, /Readiness review full-test entry: ready_for_full_test_window \(action=run_full_test_window, command=npm\.cmd test\)/);
    assert.match(result.stdout, /Readiness review full-test gate: ready \(missingCloseout=-\)/);
    assert.match(result.stdout, /Readiness review production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Readiness review missing signoff keys: full_test_window_passed, staging_artifacts_archived, launch_mainline_receipts_visible/);
    assert.match(result.stdout, /Readiness review missing receipt visibility: launchMainline, launchReview, launchSmoke, developerOps, launchOpsOverviewStatus/);
    assert.match(result.stdout, /Readiness review next action: Run npm\.cmd test, then backfill production sign-off evidence into the production sign-off packet\./);
    assert.match(result.stdout, /Full-test signoff focus: ready_for_full_test_window \(fullTest=yes, signoff=no\)/);
    assert.match(result.stdout, /Full-test signoff action: backfill_production_signoff \(ready_for_full_test_window\)/);
    assert.match(result.stdout, /Full-test command: `npm\.cmd test`/);
    assert.match(result.stdout, /Full-test signoff follow-up backfill: `npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-ready\.json --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(result.stdout, /Full-test signoff readiness status: `npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-ready\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(result.stdout, /Full-test signoff reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`/);
    assert.match(result.stdout, /Full-test signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Full-test signoff missing signoff keys: full_test_window_passed, staging_artifacts_archived, launch_mainline_receipts_visible/);
    assert.match(result.stdout, /Full-test signoff missing receipt visibility: launchMainline, launchReview, launchSmoke, developerOps, launchOpsOverviewStatus/);
    assert.match(result.stdout, /Go-live execution entry: ready_for_full_test_window \(phase=full_test_window_entry, source=fullTestSignoffFocus, action=run_full_test_window\)/);
    assert.match(result.stdout, /Production signoff evidence execution entry: awaiting_production_signoff_evidence \(action=run_full_test_window, current=full_test_window_passed\)/);
    assert.match(result.stdout, /Production signoff evidence queue: full_test_window_passed:pending_operator_evidence, staging_artifacts_archived:pending_operator_evidence/);
    assert.match(result.stdout, /Production signoff receipt visibility queue: launchMainline:pending_visibility_review, launchReview:pending_visibility_review, launchSmoke:pending_visibility_review, developerOps:pending_visibility_review, launchOpsOverviewStatus:pending_visibility_review/);
    assert.match(result.stdout, /Production signoff evidence current backfill: `npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-ready\.json --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(result.stdout, /Production signoff evidence readiness status: `npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-ready\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(result.stdout, /Production signoff evidence reload: blocked_until_production_signoff_backfill -> `npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-ready\.json`/);
    assert.match(result.stdout, /Production signoff evidence current packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner focuses closeout reload after real staging inputs are ready", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-real-ready-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    const handoffFile = join(tempDir, "ready-handoff.md");
    const closeoutFile = join(tempDir, "ready-closeout.json");
    const runRecordFile = join(tempDir, "ready-run-record-index.json");
    const artifactManifestFile = join(tempDir, "ready-artifact-manifest.json");
    const backupRestorePacketFile = join(tempDir, "ready-backup-restore-drill-packet.json");
    const closeoutReloadPacketFile = join(tempDir, "ready-closeout-reload-packet.json");
    const readinessReviewPacketFile = join(tempDir, "ready-readiness-review-packet.json");
    const productionSignoffPacketFile = join(tempDir, "ready-production-signoff-packet.json");
    const launchDutyArchiveIndexFile = join(tempDir, "ready-launch-duty-archive-index.json");
    const filledCloseoutDraftFile = join(tempDir, "ready-filled-closeout-input.draft.json");
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://ready-staging.example.com",
      productCode: "READY_PRODUCT",
      channel: "stable",
      adminUsername: "ready-admin@example.com",
      developerUsername: "ready.developer",
      targetOs: "linux",
      storageProfile: "postgres-preview",
      targetEnvFile: "/etc/rocksolidlicense/ready.env",
      appBackupDir: "/var/lib/rocksolid/ready-backups",
      postgresBackupDir: "/var/lib/rocksolid/ready-postgres-backups"
    }, null, 2));

    const result = runRehearsal([
      "--profile-file",
      profileFile,
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--backup-restore-packet-file",
      backupRestorePacketFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--production-signoff-packet-file",
      productionSignoffPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "ReadyAdmin123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "ReadyDeveloper123!",
      RSL_DEVELOPER_BEARER_TOKEN: "ready-developer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.stagingProfileOperatorPreflight.status, "ready_for_real_staging_rehearsal");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.status, "ready_for_real_staging_rehearsal");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.canRunDryRun, true);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.canRecordEvidence, true);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.currentAction.key, "run_staging_dry_run");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.postDryRunAction.key, "backfill_and_reload_closeout_input");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.postDryRunAction.status, "blocked_until_closeout_reload");
    assert.equal(
      output.operatorExecutionPlan.realStagingRunFocus.postDryRunAction.command,
      "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json"
    );
    assert.deepEqual(
      output.operatorExecutionPlan.realStagingInputClosure.operatorSteps.map((item) => [item.key, item.status]),
      [
        ["load_staging_profile", "ready"],
        ["set_required_secret_env", "ready"],
        ["confirm_artifact_output_paths", "ready"],
        ["confirm_artifact_archive_root", "ready"],
        ["backfill_filled_closeout_input", "operator_backfill"]
      ]
    );
    assert.deepEqual(
      output.filledCloseoutInputDraft.operatorSteps.map((item) => [item.key, item.status]),
      [
        ["review_draft_field_sources", "operator_review"],
        ["copy_draft_to_filled_closeout_input", "operator_execute"],
        ["replace_placeholder_values", "operator_backfill"],
        ["remove_example_only_and_reload", "operator_execute"],
        ["review_full_test_window_gate", "blocked_until_closeout_reload"]
      ]
    );
    assert.equal(
      output.filledCloseoutInputDraft.acceptanceFields.find((item) => item.key === "launch_mainline_evidence_receipts")?.receiptOperations.includes("record_launch_rehearsal_run"),
      true
    );
    assert.match(
      output.filledCloseoutInputDraft.acceptanceFields.find((item) => item.key === "launch_mainline_evidence_receipts")?.expectedEvidence || "",
      /Launch Mainline receipt IDs/
    );
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.fullTestEntry.status, "blocked_until_closeout_reload");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.fullTestEntry.command, "npm.cmd test");
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.fullTestEntry.missingCloseoutKeys.length, 7);
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.liveWriteSmokeResultCaptureEntry, {
      mode: "live-write-smoke-result-capture-entry",
      status: "ready_for_live_write_smoke_result_capture",
      willModifyData: false,
      commandWillModifyData: true,
      currentActionKey: "run_live_write_smoke",
      currentCommand: output.nextCommands.launchSmoke,
      approval: {
        required: true,
        sourceStep: "approve_live_write_smoke",
        status: "operator_confirm_required"
      },
      resultBackfillTarget: {
        key: "live_write_smoke_result",
        status: "pending_operator_result",
        closeoutInputPath: "artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json",
        artifactPath: "artifacts/staging/READY_PRODUCT/stable/live-write-smoke-output.json",
        sourceStep: "run_live_write_smoke",
        receiptOperations: ["record_launch_rehearsal_run"],
        reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json",
        expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
      },
      receiptTargets: [
        { operation: "record_launch_rehearsal_run", status: "pending_operator_receipt" }
      ],
      nextAction: "Confirm live-write approval, run launch:smoke:staging, record the launch rehearsal receipt, backfill live_write_smoke_result, then reload closeout input."
    });
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.status, "ready_for_real_staging_rehearsal");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentPhase, "real_staging_inputs");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.sourceFocus, "realStagingRunFocus");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentActionKey, "run_staging_dry_run");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentCommand, output.stagingEnvironmentBinding.dryRunCommand);
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.commands.closeoutReload,
      "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json"
    );
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.paths.filledCloseoutInputFile, "artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.blockerSummary.missingCloseoutKeys.length, 7);
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.executionEntry, {
      mode: "real-staging-execution-entry",
      status: "ready_for_dry_run",
      willModifyData: false,
      currentActionKey: "run_staging_dry_run",
      currentCommand: output.stagingEnvironmentBinding.dryRunCommand,
      preflight: {
        profile: {
          status: "ready",
          path: profileFile
        },
        secretEnv: {
          status: "ready",
          missingKeys: [],
          unsafeCliSecretOverrides: []
        },
        outputBundle: {
          status: "written",
          writtenFileCount: 10,
          outputFileCount: 10,
          archiveEntrypoint: {
            key: "launch_duty_archive_index",
            status: "written",
            path: launchDutyArchiveIndexFile
          }
        },
        artifactArchive: {
          status: "ready",
          path: "artifacts/staging/READY_PRODUCT/stable"
        }
      },
      evidenceBackfill: {
        targetCount: 7,
        currentTarget: {
          key: "route_map_gate_result",
          sourceStep: "run_route_map_gate",
          artifactPath: "artifacts/staging/READY_PRODUCT/stable/route-map-gate-output.txt",
          receiptOperations: []
        },
        closeoutInputPath: "artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json",
        closeoutReloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/READY_PRODUCT/stable/filled-closeout-input.json",
        closeoutReloadPacketFile
      },
      nextAction: "Run the profile-driven staging dry run, then backfill route_map_gate_result into filled-closeout-input.json and reload closeout readiness."
    });
    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, /Real staging run focus: ready_for_real_staging_rehearsal \(dryRun=yes, liveWriteSmoke=yes, evidence=yes\)/);
    assert.match(handoff, /Go-live execution entry: ready_for_real_staging_rehearsal \(phase=real_staging_inputs, source=realStagingRunFocus, action=run_staging_dry_run\)/);
    assert.match(handoff, /Go-live execution command: `npm\.cmd run staging:rehearsal -- --json --base-url https:\/\/ready-staging\.example\.com/);
    assert.match(handoff, /Real staging execution entry: ready_for_dry_run \(action=run_staging_dry_run, outputs=written 10\/10\)/);
    assert.match(handoff, /Real staging execution current command: `npm\.cmd run staging:rehearsal -- --json --base-url https:\/\/ready-staging\.example\.com/);
    assert.match(handoff, /Real staging execution first backfill: route_map_gate_result -> artifacts\/staging\/READY_PRODUCT\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /Real staging execution closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/READY_PRODUCT\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /Live-write smoke result capture entry: ready_for_live_write_smoke_result_capture \(action=run_live_write_smoke, target=live_write_smoke_result\)/);
    assert.match(handoff, /Live-write smoke result backfill: pending_operator_result -> artifacts\/staging\/READY_PRODUCT\/stable\/live-write-smoke-output\.json \(closeout=artifacts\/staging\/READY_PRODUCT\/stable\/filled-closeout-input\.json\)/);
    assert.match(handoff, /Live-write smoke result receipts: record_launch_rehearsal_run:pending_operator_receipt/);
    assert.match(handoff, /Real staging current action: run_staging_dry_run \(env=-\)/);
    assert.match(handoff, /Real staging post-dry-run action: backfill_and_reload_closeout_input \(blocked_until_closeout_reload\)/);
    assert.match(handoff, /Real staging full-test entry: blocked_until_closeout_reload \(command=npm\.cmd test\)/);
    assert.match(handoff, /Operator real staging steps:[\s\S]*load_staging_profile: ready[\s\S]*confirm_artifact_archive_root: ready[\s\S]*backfill_filled_closeout_input: operator_backfill/);
    assert.match(handoff, /Operator real staging steps:[\s\S]*expectedEvidence: Reload the filled closeout input and confirm the remaining missing closeout keys are empty before the full test window\./);
    assert.match(handoff, /## Filled Closeout Input Draft[\s\S]*Draft operator steps:[\s\S]*copy_draft_to_filled_closeout_input: operator_execute[\s\S]*remove_example_only_and_reload: operator_execute/);
    assert.match(handoff, /## Filled Closeout Input Draft[\s\S]*live_write_smoke_result: run_live_write_smoke -> artifacts\/staging\/READY_PRODUCT\/stable\/live-write-smoke-output\.json[\s\S]*receiptOperations: record_launch_rehearsal_run[\s\S]*expectedEvidence: Record smoke exit status, created test project\/account\/card identifiers, and the redacted smoke output artifact path\./);
    assert.match(handoff, /## Filled Closeout Input Draft[\s\S]*launch_mainline_evidence_receipts: record_launch_mainline_evidence -> artifacts\/staging\/READY_PRODUCT\/stable\/launch-mainline-evidence-receipts\.json[\s\S]*receiptOperations: record_launch_rehearsal_run, record_recovery_drill, record_backup_verification/);
    assert.doesNotMatch(result.stdout, /ReadyAdmin123!|ReadyDeveloper123!|ready-developer-token/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal profile gate requires launch-critical packet output paths", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-profile-output-gate-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    const handoffFile = join(tempDir, "profile-handoff.md");
    const closeoutFile = join(tempDir, "profile-closeout.json");
    const runRecordFile = join(tempDir, "profile-run-record-index.json");
    const artifactManifestFile = join(tempDir, "profile-artifact-manifest.json");
    const closeoutReloadPacketFile = join(tempDir, "profile-closeout-reload-packet.json");
    const readinessReviewPacketFile = join(tempDir, "profile-readiness-review-packet.json");
    const launchDutyArchiveIndexFile = join(tempDir, "profile-launch-duty-archive-index.json");
    const filledCloseoutDraftFile = join(tempDir, "profile-filled-closeout-input.draft.json");
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://profile-staging.example.com",
      productCode: "PROFILE_PRODUCT",
      channel: "stable",
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
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "ProfileAdmin123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "ProfileDeveloper123!",
      RSL_DEVELOPER_BEARER_TOKEN: "developer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.stagingProfileLaunchPlan.status, "needs_profile_completion");
    assert.deepEqual(output.stagingProfileLaunchPlan.missingRequiredInputs, []);
    assert.deepEqual(output.stagingProfileLaunchPlan.missingOutputFiles, [
      "backupRestorePacketFile",
      "productionSignoffPacketFile"
    ]);
    assert.match(output.stagingProfileLaunchPlan.nextAction, /Complete missing staging profile inputs and launch-duty output paths/);
    assert.equal(output.stagingProfileOperatorPreflight.status, "missing_profile_inputs");
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingOutputFiles, [
      "backupRestorePacketFile",
      "productionSignoffPacketFile"
    ]);
    assert.equal(output.stagingProfileOperatorPreflight.canRunDryRun, false);
    assert.equal(
      output.stagingProfileOperatorPreflight.checks.find((item) => item.key === "output_files").status,
      "missing"
    );
    assert.deepEqual(
      output.operatorExecutionPlan.realStagingInputClosure.checks.find((item) => item.key === "artifact_output_paths").missing,
      ["backupRestorePacketFile", "productionSignoffPacketFile"]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.realStagingInputClosure.operatorSteps.find((item) => item.key === "confirm_artifact_output_paths").missingKeys,
      ["backupRestorePacketFile", "productionSignoffPacketFile"]
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("staging rehearsal profile gate requires password secrets to come from environment variables", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-profile-secret-env-gate-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    const handoffFile = join(tempDir, "profile-handoff.md");
    const closeoutFile = join(tempDir, "profile-closeout.json");
    const runRecordFile = join(tempDir, "profile-run-record-index.json");
    const artifactManifestFile = join(tempDir, "profile-artifact-manifest.json");
    const backupRestorePacketFile = join(tempDir, "profile-backup-restore-drill-packet.json");
    const closeoutReloadPacketFile = join(tempDir, "profile-closeout-reload-packet.json");
    const readinessReviewPacketFile = join(tempDir, "profile-readiness-review-packet.json");
    const productionSignoffPacketFile = join(tempDir, "profile-production-signoff-packet.json");
    const launchDutyArchiveIndexFile = join(tempDir, "profile-launch-duty-archive-index.json");
    const filledCloseoutDraftFile = join(tempDir, "profile-filled-closeout-input.draft.json");
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://profile-staging.example.com",
      productCode: "PROFILE_PRODUCT",
      channel: "stable",
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
      "--admin-password",
      "CliAdminShouldNotClearProfileGate123!",
      "--developer-password",
      "CliDeveloperShouldNotClearProfileGate123!",
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--backup-restore-packet-file",
      backupRestorePacketFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--production-signoff-packet-file",
      productionSignoffPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
    ], {
      RSL_DEVELOPER_BEARER_TOKEN: "developer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.stagingProfileLaunchPlan.status, "ready_for_profile_driven_rehearsal");
    assert.deepEqual(output.stagingProfileLaunchPlan.unsafeCliSecretOverrides, [
      "--admin-password",
      "--developer-password"
    ]);
    assert.deepEqual(
      output.stagingProfileLaunchPlan.requiredSecretEnv.map((item) => [item.key, item.present, item.source]),
      [
        ["RSL_SMOKE_ADMIN_PASSWORD", false, "missing_env"],
        ["RSL_SMOKE_DEVELOPER_PASSWORD", false, "missing_env"],
        ["RSL_DEVELOPER_BEARER_TOKEN", true, "env"]
      ]
    );
    assert.equal(output.stagingProfileOperatorPreflight.status, "blocked_until_secret_env");
    assert.deepEqual(output.stagingProfileOperatorPreflight.unsafeCliSecretOverrides, [
      "--admin-password",
      "--developer-password"
    ]);
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingSecretEnv, [
      "RSL_SMOKE_ADMIN_PASSWORD",
      "RSL_SMOKE_DEVELOPER_PASSWORD"
    ]);
    assert.equal(output.stagingProfileOperatorPreflight.canRunDryRun, true);
    assert.equal(output.stagingProfileOperatorPreflight.canRunLiveWriteSmoke, false);
    assert.equal(output.operatorExecutionPlan.realStagingRunFocus.currentAction.key, "set_required_secret_env");
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.currentAction.envKeys, [
      "RSL_SMOKE_ADMIN_PASSWORD",
      "RSL_SMOKE_DEVELOPER_PASSWORD"
    ]);
    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, /Unsafe CLI secret overrides: --admin-password, --developer-password/);
    assert.match(handoff, /RSL_SMOKE_ADMIN_PASSWORD: missing before_live_write_smoke \(source=missing_env\)/);
    assert.match(handoff, /RSL_SMOKE_DEVELOPER_PASSWORD: missing before_live_write_smoke \(source=missing_env\)/);
    assert.match(handoff, /RSL_DEVELOPER_BEARER_TOKEN: set before_evidence_recording \(source=env\)/);
    assert.doesNotMatch(result.stdout, /CliAdminShouldNotClearProfileGate123!|CliDeveloperShouldNotClearProfileGate123!/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("staging rehearsal profile gate keeps cli secret overrides visible after env secrets are set", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-profile-cli-secret-override-"));
  const profileFile = join(tempDir, "staging-profile.json");
  const handoffFile = join(tempDir, "handoff.md");
  const closeoutFile = join(tempDir, "closeout-template.json");
  const runRecordFile = join(tempDir, "profile-run-record-index.json");
  const artifactManifestFile = join(tempDir, "profile-artifact-manifest.json");
  const backupRestorePacketFile = join(tempDir, "profile-backup-restore-packet.json");
  const closeoutReloadPacketFile = join(tempDir, "profile-closeout-reload-packet.json");
  const readinessReviewPacketFile = join(tempDir, "profile-readiness-review-packet.json");
  const productionSignoffPacketFile = join(tempDir, "profile-production-signoff-packet.json");
  const launchDutyArchiveIndexFile = join(tempDir, "profile-launch-duty-archive-index.json");
  const filledCloseoutDraftFile = join(tempDir, "profile-filled-closeout-input.draft.json");
  try {
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://profile-staging.example.com",
      productCode: "PROFILE_PRODUCT",
      channel: "stable",
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
      "--admin-password",
      "CliAdminShouldStayFlagOnly123!",
      "--developer-password",
      "CliDeveloperShouldStayFlagOnly123!",
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile,
      "--run-record-file",
      runRecordFile,
      "--artifact-manifest-file",
      artifactManifestFile,
      "--backup-restore-packet-file",
      backupRestorePacketFile,
      "--closeout-reload-packet-file",
      closeoutReloadPacketFile,
      "--readiness-review-packet-file",
      readinessReviewPacketFile,
      "--production-signoff-packet-file",
      productionSignoffPacketFile,
      "--launch-duty-archive-index-file",
      launchDutyArchiveIndexFile,
      "--filled-closeout-draft-file",
      filledCloseoutDraftFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "EnvAdminSecret123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "EnvDeveloperSecret123!",
      RSL_DEVELOPER_BEARER_TOKEN: "developer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingSecretEnv, []);
    assert.deepEqual(output.stagingProfileOperatorPreflight.unsafeCliSecretOverrides, [
      "--admin-password",
      "--developer-password"
    ]);
    assert.equal(output.stagingProfileOperatorPreflight.status, "blocked_until_secret_env");
    assert.equal(output.stagingProfileOperatorPreflight.canRunLiveWriteSmoke, false);
    assert.equal(output.operatorExecutionPlan.realStagingInputClosure.status, "blocked_until_secret_env");
    assert.deepEqual(output.operatorExecutionPlan.realStagingInputClosure.unsafeCliSecretOverrides, [
      "--admin-password",
      "--developer-password"
    ]);
    assert.equal(output.operatorExecutionPlan.realStagingInputClosure.checks[1].status, "unsafe_cli_override");
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.currentAction, {
      key: "move_cli_secret_overrides_to_env",
      status: "blocked",
      unsafeCliSecretOverrides: [
        "--admin-password",
        "--developer-password"
      ],
      nextAction: "Remove CLI password flags and rely on the required secret environment variables before evidence recording or live-write duty continues."
    });
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.orderedNextActions.slice(0, 1),
      ["move_cli_secret_overrides_to_env"]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.blockingReasons[0].key, "unsafe_cli_secret_overrides");
    assert.deepEqual(output.stagingRehearsalExecutionSummary.blockingReasons[0].unsafeCliSecretOverrides, [
      "--admin-password",
      "--developer-password"
    ]);
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.currentBlocker.operatorAction.unsafeCliSecretOverrides,
      ["--admin-password", "--developer-password"]
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.remainingBlockers
        .filter((item) => item.key === "unsafe_cli_secret_overrides")
        .map((item) => [item.key, item.unsafeCliSecretOverrides]),
      [["unsafe_cli_secret_overrides", ["--admin-password", "--developer-password"]]]
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.nextPlan.slice(0, 1),
      [{
        key: "move_cli_secret_overrides_to_env",
        status: "operator_prepare",
        nextAction: "Remove CLI password flags and rely on the required secret environment variables before evidence recording."
      }]
    );
    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, /Unsafe CLI secret overrides: --admin-password, --developer-password/);
    assert.match(handoff, /Launch closure remaining blockers: unsafe_cli_secret_overrides/);
    assert.match(handoff, /Operator real input required_secret_env: unsafe_cli_override/);
    assert.match(handoff, /unsafeCliSecretOverrides: --admin-password, --developer-password/);
    assert.doesNotMatch(result.stdout, /CliAdminShouldStayFlagOnly123!|CliDeveloperShouldStayFlagOnly123!/);
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
    assert.match(handoff, /## Staging Rehearsal Execution Summary/);
    assert.match(handoff, /Execution summary status: profile_not_loaded/);
    assert.match(handoff, /Real staging input closure: blocked_until_profile_and_paths \(ready=1, blocked=4\)/);
    assert.match(handoff, /Go-live progress: blocked_until_real_staging_inputs \(ready=1, blocked=8, scriptReadiness=11%\)/);
    assert.match(handoff, /Go-live current blocker: staging_profile/);
    assert.match(handoff, /Go-live current action: load_profile \(command=npm\.cmd run staging:rehearsal -- --profile-file <staging-profile\.json>.*env=-, artifact=-\)/);
    assert.match(handoff, /Go-live blocked queue: staging_profile -> required_secret_env -> artifact_output_paths -> filled_closeout_input -> full_test_window -> production_signoff -> launch_day_watch -> stabilization_handoff/);
    assert.match(handoff, /Go-live action queue:/);
    assert.match(handoff, /staging_profile: load_profile \(command=npm\.cmd run staging:rehearsal -- --profile-file <staging-profile\.json>/);
    assert.match(handoff, /required_secret_env: set_env \(command=-, env=RSL_DEVELOPER_BEARER_TOKEN, artifact=-\)/);
    assert.match(handoff, /filled_closeout_input: create_file \(command=npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json, env=-, artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json\)/);
    assert.match(handoff, /Launch closure status: blocked_until_real_staging_inputs \(remainingBlockers=5\)/);
    assert.match(handoff, /Launch closure next plan: load_staging_profile -> set_missing_secret_env -> backfill_and_reload_closeout_input -> run_full_test_window -> backfill_production_signoff -> start_launch_day_watch/);
    assert.match(handoff, /Launch duty focus: blocked_until_signoff_ready \(postSignoffBlocked=8, watchPending=0\)/);
    assert.match(handoff, /Launch duty next action: Complete production sign-off before starting launch-day watch\./);
    assert.match(handoff, /## Launch Route Map Targeted Gate/);
    assert.match(handoff, /npm\.cmd run launch:route-map-gate/);
    assert.match(handoff, /npm\.cmd run launch:route-map-gate -- --dry-run --json/);
    assert.match(handoff, /first-batch runtime evidence/);
    assert.match(handoff, /Launch Mainline route map must surface Launch Ops Overview Evidence before live-write smoke/);
    assert.match(handoff, /Verify productionSignoffPacket and launchDayWatchEntry in the route-map gate output/);
    assert.match(handoff, /## Receipt Visibility Summary Downloads/);
    assert.match(handoff, /Launch Review summary: `https:\/\/staging\.example\.com\/api\/developer\/launch-review\/download\?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary`/);
    assert.match(handoff, /Launch Smoke Kit summary: `https:\/\/staging\.example\.com\/api\/developer\/launch-smoke-kit\/download\?productCode=PILOT_ALPHA&channel=stable&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary`/);
    assert.match(handoff, /Launch Ops Overview Status: `https:\/\/staging\.example\.com\/api\/developer\/ops\/export\/download\?productCode=PILOT_ALPHA&format=launch-operations-overview-status&limit=20`/);
    assert.match(handoff, /Launch Ops Overview Status verifies receipt visibility, productionSignoffPacket, and launchDayWatchEntry for cutover/);
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
    assert.match(handoff, /2\. Run route-map, first-batch runtime evidence, and download-surface gate/);
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
    assert.match(handoff, /## Full Test Window Readiness[\s\S]*Full-test result capture entry: blocked_until_closeout_reload \(action=reload_closeout_input, target=full_test_window_passed\)[\s\S]*Full-test result capture command: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`[\s\S]*Full-test result capture expected evidence: Attach the full `npm\.cmd test` output summary and failure count\.[\s\S]*## Production Sign-Off Readiness/);
    assert.match(handoff, /## Full Test Window Readiness[\s\S]*Closeout evidence targets:[\s\S]*route_map_gate_result: missing \(run_route_map_gate\)[\s\S]*expectedEvidence: Record the targeted gate exit status, pass count, and redacted output artifact path\.[\s\S]*operator_go_no_go: missing \(backfill_filled_closeout_input\)[\s\S]*expectedEvidence: Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp\.[\s\S]*## Production Sign-Off Readiness/);
    assert.match(handoff, /## Production Sign-Off Readiness/);
    assert.match(handoff, /Can sign off: no/);
    assert.match(handoff, /Missing sign-off keys: full_test_window_passed, staging_artifacts_archived, launch_mainline_receipts_visible, launch_ops_overview_status_visible, backup_restore_drill_passed, rollback_path_confirmed, operator_signoff_recorded/);
    assert.match(handoff, /Missing receipt visibility keys: launchMainline, launchReview, launchSmoke, developerOps, launchOpsOverviewStatus/);
    assert.match(handoff, /## Production Sign-Off Readiness[\s\S]*Sign-off evidence targets:[\s\S]*full_test_window_passed: missing[\s\S]*expectedEvidence: Attach the full `npm\.cmd test` output summary and failure count\.[\s\S]*operator_signoff_recorded: missing[\s\S]*expectedEvidence: Record operator, timestamp, decision, and reason in the go\/no-go artifact\.[\s\S]*Receipt visibility evidence targets:[\s\S]*launchOpsOverviewStatus: missing[\s\S]*expectedEvidence: Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover\.[\s\S]*## Staging Backup \/ Restore Drill Packet/);
    assert.match(handoff, /## Staging Backup \/ Restore Drill Packet[\s\S]*Expected evidence: Record backup artifact path, restore dry-run result, and post-restore healthcheck result\.[\s\S]*Operator steps:[\s\S]*run_app_backup: operator_execute[\s\S]*expectedEvidence: Capture app backup command exit status and backup artifact path\.[\s\S]*run_postgres_restore_dry_run: operator_execute[\s\S]*expectedEvidence: Capture restore dry-run exit status and separate restore-target healthcheck result\.[\s\S]*record_backup_verification_receipt: operator_execute[\s\S]*expectedEvidence: Record the backup verification receipt ID for the app\/Postgres backup artifacts\.[\s\S]*backfill_closeout_key: operator_backfill[\s\S]*expectedEvidence: Backfill backup_restore_drill_result with the backup artifact path, restore dry-run result, healthcheck result, and receipt IDs\.[\s\S]*## Staging Closeout Reload Packet/);
    assert.match(handoff, /## Staging Backup \/ Restore Drill Packet[\s\S]*Backup\/restore closeout backfill command: `npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup-restore-drill\.txt --receipt-id <recovery-drill-receipt-id> --receipt-id <backup-verification-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`[\s\S]*Backup\/restore readiness status: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`[\s\S]*## Staging Closeout Reload Packet/);
    assert.match(handoff, /## Staging Backup \/ Restore Drill Packet[\s\S]*Backup\/restore result capture entry: awaiting_backup_restore_result \(action=run_backup_restore_drill, target=backup_restore_drill_result\)[\s\S]*Backup\/restore result backfill: pending_operator_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/backup-restore-drill\.txt \(closeout=artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json\)[\s\S]*Backup\/restore result receipts: record_recovery_drill:pending_operator_receipt, record_backup_verification:pending_operator_receipt[\s\S]*Backup\/restore result reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`[\s\S]*## Staging Closeout Reload Packet/);
    assert.match(handoff, /## Staging Backup \/ Restore Drill Packet[\s\S]*Backup\/restore execution entry: awaiting_backup_restore_drill \(action=run_app_backup, target=backup_restore_drill_result\)[\s\S]*Backup\/restore execution command sequence: run_app_backup:operator_execute, run_postgres_backup:operator_execute, run_postgres_restore_dry_run:operator_execute, run_restore_healthcheck:operator_execute[\s\S]*Backup\/restore execution receipts: record_recovery_drill:pending_operator_receipt, record_backup_verification:pending_operator_receipt[\s\S]*Backup\/restore execution reload: blocked_until_backup_restore_backfill -> `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`[\s\S]*## Staging Closeout Reload Packet/);
    assert.match(handoff, /## Staging Backup \/ Restore Drill Packet[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Staging Closeout Reload Packet/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Backup\/restore gate: blocked \(packet=awaiting_backup_restore_drill, closeoutKey=backup_restore_drill_result\)[\s\S]*Backup\/restore next action: Backfill backup_restore_drill_result before treating closeout reload as full-test ready\.[\s\S]*## Staging Readiness Review Packet/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Post-live-write execution entry: awaiting_post_live_write_capture \(action=archive_launch_smoke_handoff, current=launch_smoke_handoff\)[\s\S]*Post-live-write execution capture queue: launch_smoke_handoff:pending_operator_result, launch_mainline_evidence_receipts:pending_operator_result, receipt_visibility_review:pending_operator_result[\s\S]*Post-live-write execution receipts: launch_smoke_handoff=record_post_launch_ops_sweep:pending_operator_receipt; launch_mainline_evidence_receipts=record_launch_rehearsal_run:pending_operator_receipt[\s\S]*Post-live-write execution reload: blocked_until_post_live_write_backfill -> `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`[\s\S]*## Staging Readiness Review Packet/);
    assert.match(handoff, /## Staging Production Sign-Off Packet/);
    assert.match(handoff, /Sign-off backfill draft: blocked_until_full_test_window/);
    assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Launch Day Watch Plan/);
    assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Production signoff execution entry: blocked_until_full_test_window \(action=run_full_test_window, canSignoff=no\)[\s\S]*Production signoff execution current command: `npm\.cmd test`[\s\S]*Production signoff execution current signoff key: full_test_window_passed[\s\S]*Production signoff execution current receipt visibility: launchMainline[\s\S]*Production signoff execution launch-day watch: blocked_until_signoff_ready \(target=production_signoff_packet\)[\s\S]*## Launch Day Watch Plan/);
  assert.match(handoff, /Sign-off draft closeout input: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json/);
  assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Sign-off conditions:[\s\S]*full_test_window_passed: missing[\s\S]*expectedEvidence: Attach the full `npm\.cmd test` output summary and failure count\.[\s\S]*Receipt visibility evidence targets:[\s\S]*developerOps: missing[\s\S]*expectedEvidence: Confirm Developer Ops receipt visibility shows the latest staging evidence receipts before cutover\.[\s\S]*Operator steps:[\s\S]*run_full_test_window: blocked_until_closeout_reload[\s\S]*expectedEvidence: Run npm\.cmd test and capture the pass\/fail summary before production sign-off\.[\s\S]*verify_receipt_visibility: operator_backfill[\s\S]*expectedEvidence: Confirm Launch Mainline, Launch Review, Launch Smoke, Developer Ops, and Launch Ops Overview Status receipt visibility before cutover\.[\s\S]*## Launch Day Watch Plan/);
  assert.match(handoff, /Post-signoff targets:/);
  assert.match(handoff, /production_signoff_packet: blocked_until_signoff_ready \(action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
  assert.match(handoff, /launch_day_watch_summary: blocked_until_signoff_ready \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
  assert.match(handoff, /stabilization_owner_handoff: blocked_until_signoff_ready \(action=handoff_stabilization_owner\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
  assert.match(handoff, /Launch-day watch bridge: blocked_until_signoff_ready \(source=blocked, watchDraft=blocked_until_production_signoff, target=production_signoff_packet\)/);
  assert.match(handoff, /Launch-day watch evidence inputs: production_signoff_packet=blocked_until_signoff_ready -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json; launch_day_watch_summary=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; stabilization_owner_handoff=blocked_until_cutover_watch -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
  assert.match(handoff, /Launch-day watch record queue:/);
  assert.match(handoff, /launch_day_watch_summary: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*receiptOperations: record_cutover_walkthrough, record_launch_day_readiness_review[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\./);
  assert.match(handoff, /Launch-day watch stabilization windows:/);
  assert.match(handoff, /stabilization_owner_handoff: blocked_until_cutover_watch -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*label: T\+2h stabilization owner handoff[\s\S]*expectedEvidence: Record stabilization owner, timestamp, unresolved items, and next-duty follow-up\./);
  assert.match(handoff, /## Launch Day Watch Plan/);
  assert.match(handoff, /Can start cutover watch: no/);
  assert.match(handoff, /Watch record draft: blocked_until_production_signoff/);
  assert.match(handoff, /Watch draft records: launch_day_watch_summary, receipt_visibility_snapshot, first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
  assert.match(handoff, /## Launch Day Watch Plan[\s\S]*Watch record queue:[\s\S]*receipt_visibility_snapshot: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt[\s\S]*receiptOperations: record_post_launch_ops_sweep[\s\S]*expectedEvidence: Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots\./);
  assert.match(handoff, /## Launch Day Watch Plan[\s\S]*Launch-day watch execution entry: blocked_until_production_signoff \(action=complete_production_signoff, record=launch_day_watch_summary\)[\s\S]*Launch-day watch execution current record: launch_day_watch_summary -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*Launch-day watch execution stabilization target: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*## Stabilization Handoff Plan/);
  assert.match(handoff, /Watch windows: cutover_watch, first_wave_stabilization/);
  assert.match(handoff, /Escalation triggers: production_signoff_missing, receipt_visibility_missing, launch_mainline_action_failure, developer_ops_receipt_mismatch, backup_restore_or_rollback_unclear/);
  assert.match(handoff, /## Stabilization Handoff Plan/);
    assert.match(handoff, /Can start stabilization handoff: no/);
    assert.match(handoff, /Required evidence keys: launch_day_watch_summary, first_wave_incident_log, receipt_visibility_snapshot, rollback_signal_review, stabilization_owner_handoff/);
    assert.match(handoff, /## Stabilization Handoff Plan[\s\S]*Stabilization handoff execution entry: blocked_until_cutover_watch \(action=verify_cutover_watch_records, target=stabilization_owner_handoff\)[\s\S]*Stabilization handoff execution target: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*Stabilization handoff execution first-wave closeout: first_wave_closeout -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*## Staging Rehearsal Run Record Index/);
    assert.match(handoff, /Handoff windows: T\+2h stabilization owner handoff, T\+24h first-wave closeout/);
    assert.match(handoff, /Current handoff target: stabilization_owner_handoff \(blocked_until_cutover_watch\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /First-wave closeout gate: blocked_until_stabilization_handoff \(owner=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md, closeout=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md\)/);
    assert.match(handoff, /Handoff evidence inputs: launch_day_watch_summary=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; first_wave_incident_log=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; receipt_visibility_snapshot=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt; rollback_signal_review=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /## Stabilization Handoff Plan[\s\S]*Operator steps:[\s\S]*verify_cutover_watch_records: blocked_until_cutover_watch[\s\S]*artifactPaths: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md, artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md, artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt, artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md, artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*handoff_stabilization_owner: blocked_until_cutover_watch[\s\S]*artifactPath: artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*close_first_wave: blocked_until_stabilization_owner_handoff[\s\S]*artifactPath: artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /## Stabilization Handoff Plan[\s\S]*Source watch records:[\s\S]*rollback_signal_review: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md[\s\S]*receiptOperations: record_rollback_walkthrough, record_launch_stabilization_review[\s\S]*expectedEvidence: Record whether rollback signals were observed, dismissed, or escalated\./);
    assert.match(handoff, /## Staging Run Record Template/);
    assert.match(handoff, /Archive root: artifacts\/staging\/PILOT_ALPHA\/stable/);
    assert.match(handoff, /Closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`/);
    assert.match(handoff, /launch_day_watch_summary: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /stabilization_owner_handoff: artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /## Staging Rehearsal Run Record Index/);
    assert.match(handoff, /Run record index status: awaiting_evidence_backfill/);
    assert.match(handoff, /## Staging Rehearsal Run Record Index[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Staging Artifact Manifest/);
    assert.match(handoff, /Go-live execution command: `npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(handoff, /Closeout progress: missing=7/);
    assert.match(handoff, /pre_full_test_closeout: awaiting_operator_evidence \(records=7\)/);
    assert.match(handoff, /production_signoff: blocked_until_full_test_window \(records=7\)/);
    assert.match(handoff, /Next action: Collect the missing pre-full-test record artifacts, backfill filled-closeout-input\.json, then reload closeout input\./);
    assert.match(handoff, /## Staging Artifact Manifest/);
    assert.match(handoff, /Artifact manifest status: awaiting_artifact_generation/);
    assert.match(handoff, /## Staging Artifact Manifest[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Staging Launch Duty Archive Index/);
    assert.match(handoff, /## Staging Launch Duty Archive Index/);
    assert.match(handoff, /Launch-duty archive index: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Staging Environment Binding/);
    assert.match(handoff, /Launch day watch status: blocked/);
    assert.match(handoff, /Stabilization handoff status: blocked/);
    assert.match(handoff, /Archive go-live action plan: status=blocked_until_real_staging_inputs, remaining=8/);
    assert.match(handoff, /Archive current go-live action: staging_profile \(phase=real_staging_inputs, kind=load_profile\)/);
    assert.match(handoff, /real_staging_inputs: ready=1, blocked=3/);
    assert.match(handoff, /Launch Ops overview status: https:\/\/staging\.example\.com\/api\/developer\/ops\/export\/download\?productCode=PILOT_ALPHA&format=launch-operations-overview-status&limit=20/);
    assert.match(handoff, /launch_day_watch_summary: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /Launch-duty signoff targets:/);
    assert.match(handoff, /production_signoff_packet: blocked_until_signoff_ready \(action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /launch_duty_archive_index: blocked_until_signoff_ready \(action=review_launch_duty_archive_index\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /Archive first-wave closeout gate: blocked_until_stabilization_handoff \(owner=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md, closeout=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md\)/);
    assert.match(handoff, /stabilization_owner_handoff: blocked_until_cutover_watch \(T\+2h stabilization owner handoff\)/);
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
    assert.match(handoff, /Execution steps:[\s\S]*approve_live_write_smoke: operator_confirm \(writes=no\)[\s\S]*expectedEvidence: Record launch-duty approval owner, timestamp, and confirmation that backup\/restore drill evidence is archived before staging writes\.[\s\S]*run_live_write_smoke: operator_execute \(writes=yes\)[\s\S]*expectedEvidence: Record smoke exit status, created test project\/account\/card identifiers, and the redacted smoke output artifact path\.[\s\S]*archive_launch_smoke_handoff: operator_archive \(writes=no\)[\s\S]*expectedEvidence: Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted\.[\s\S]*record_launch_mainline_evidence: operator_execute \(writes=yes\)[\s\S]*expectedEvidence: Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action\.[\s\S]*verify_receipt_visibility: operator_review \(writes=no\)[\s\S]*expectedEvidence: Verify Launch Review, Launch Smoke, and Launch Ops Overview Status receipt-visibility summaries show the recorded first-wave receipt\.[\s\S]*reload_closeout_input: operator_execute \(writes=no\)[\s\S]*expectedEvidence: Confirm the reloaded closeout input status, remaining missing fields, and whether the full test window can start\./);
    assert.match(handoff, /route_map_gate_result: run_route_map_gate -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /live_write_smoke_result: run_live_write_smoke -> artifacts\/staging\/PILOT_ALPHA\/stable\/live-write-smoke-output\.json[\s\S]*expectedEvidence: Record smoke exit status, created test project\/account\/card identifiers, and the redacted smoke output artifact path\./);
    assert.match(handoff, /operator_go_no_go: backfill_filled_closeout_input -> artifacts\/staging\/PILOT_ALPHA\/stable\/operator-go-no-go\.md/);
    assert.match(handoff, /## Staging Closeout Reload Packet/);
    assert.match(handoff, /Packet file: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-closeout-reload-packet\.json/);
    assert.match(handoff, /Filled closeout draft: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.draft\.json/);
    assert.match(handoff, /Filled closeout input: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Operator steps:[\s\S]*promote_filled_closeout_draft: operator_copy[\s\S]*paths: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.draft\.json -> artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*backfill_required_evidence: operator_backfill[\s\S]*missingCloseoutKeys: route_map_gate_result, backup_restore_drill_result, live_write_smoke_result, launch_smoke_handoff, launch_mainline_evidence_receipts, receipt_visibility_review, operator_go_no_go[\s\S]*expectedEvidence: Backfill every missing closeout key with redacted artifact paths, receipt IDs, and operator decisions before reload\./);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Reload execution entry: awaiting_backfill \(current=route_map_gate_result, queue=7\/7\)[\s\S]*Reload execution first queue item: route_map_gate_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt[\s\S]*Reload execution post-reload review: readiness_review_packet \(fullTest=no, command=npm\.cmd test\)/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Operator go\/no-go result capture entry: pending_operator_decision \(decision=-, action=backfill_filled_closeout_input\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/operator-go-no-go\.md[\s\S]*Operator go\/no-go allowed decisions: ready-for-full-test-window, hold, rollback-follow-up[\s\S]*Operator go\/no-go reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Post-live-write result capture entries: 3[\s\S]*launch_smoke_handoff: pending_operator_result \(action=archive_launch_smoke_handoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-smoke-handoff\.json[\s\S]*launch_mainline_evidence_receipts: pending_operator_result \(action=record_launch_mainline_evidence\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-mainline-evidence-receipts\.json[\s\S]*receipt_visibility_review: pending_operator_result \(action=verify_receipt_visibility\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-review\.txt/);
    assert.match(handoff, /Current closeout backfill command: `npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(handoff, /Current closeout status command: `npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md`/);
    assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Operator go\/no-go result capture entry: pending_operator_decision \(decision=-, action=backfill_filled_closeout_input\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/operator-go-no-go\.md[\s\S]*Operator go\/no-go next action: Record operator_go_no_go as ready-for-full-test-window before full-test window entry\./);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*review_full_test_window_readiness: blocked[\s\S]*command: `npm\.cmd test`[\s\S]*expectedEvidence: Review the readiness review packet after reload and only run npm\.cmd test once missing closeout keys are empty\./);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Post-reload targets:[\s\S]*readiness_review_packet: review_after_reload -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-readiness-review-packet\.json[\s\S]*expectedEvidence: Review the reloaded closeout status, remaining missing closeout keys, and full-test readiness from the readiness review packet\./);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*production_signoff_packet: prepare_after_full_test -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json[\s\S]*command: `npm\.cmd test`[\s\S]*requiredDecision: ready-for-production-signoff/);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*launch_duty_archive_index: archive_after_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json[\s\S]*expectedEvidence: Archive the signed production sign-off packet and prepare launch-day watch plus stabilization artifacts\./);
    assert.match(handoff, /## Staging Closeout Reload Packet[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*## Staging Readiness Review Packet/);
    assert.match(handoff, /## Staging Readiness Review Packet[\s\S]*Packet status: blocked_until_closeout_reload[\s\S]*Packet file: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-readiness-review-packet\.json[\s\S]*Closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`[\s\S]*Full test window: `npm\.cmd test`/);
    assert.match(handoff, /## Staging Readiness Review Packet[\s\S]*Full-test entry execution: blocked_until_closeout_reload \(action=reload_closeout_input, fullTest=no\)[\s\S]*Full-test entry current command: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`[\s\S]*Full-test entry signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /## Staging Readiness Review Packet[\s\S]*Go-live execution entry: awaiting_closeout_backfill \(phase=full_test_window_entry, source=closeoutBackfillFocus, action=route_map_gate_result\)[\s\S]*Readiness gates:[\s\S]*full_test_window: blocked \(canProceed=no\)[\s\S]*command: `npm\.cmd test`[\s\S]*missingCloseoutKeys: route_map_gate_result, backup_restore_drill_result, live_write_smoke_result, launch_smoke_handoff, launch_mainline_evidence_receipts, receipt_visibility_review, operator_go_no_go[\s\S]*route_map_gate_result: missing \(run_route_map_gate\)[\s\S]*expectedEvidence: Record the targeted gate exit status, pass count, and redacted output artifact path\./);
    assert.match(handoff, /## Staging Readiness Review Packet[\s\S]*production_signoff: blocked \(canProceed=no\)[\s\S]*requiredDecision: ready-for-production-signoff[\s\S]*missingSignoffKeys: full_test_window_passed, staging_artifacts_archived, launch_mainline_receipts_visible, launch_ops_overview_status_visible, backup_restore_drill_passed, rollback_path_confirmed, operator_signoff_recorded[\s\S]*full_test_window_passed: missing[\s\S]*expectedEvidence: Attach the full `npm\.cmd test` output summary and failure count\.[\s\S]*launchOpsOverviewStatus: missing[\s\S]*expectedEvidence: Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover\.[\s\S]*## Staging Production Sign-Off Packet/);
    assert.match(handoff, /## Staging Readiness Review Packet[\s\S]*Operator review steps:[\s\S]*confirm_closeout_reload: operator_execute[\s\S]*expectedEvidence: Reload the filled closeout input and confirm the closeout evidence targets are filled before entering the full test window\.[\s\S]*review_full_test_window_gate: blocked[\s\S]*expectedEvidence: Verify missing closeout keys are empty, then run npm\.cmd test in the reserved full-test window\.[\s\S]*review_production_signoff_gate: blocked[\s\S]*expectedEvidence: Verify every production sign-off condition and all receipt-visibility lanes have redacted evidence before cutover\.[\s\S]*## Staging Production Sign-Off Packet/);
    assert.match(handoff, /readiness_review_packet: review_after_reload -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-readiness-review-packet\.json/);
    assert.match(handoff, /production_signoff_packet: prepare_after_full_test -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /launch_duty_archive_index: archive_after_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
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
    assert.match(handoff, /Local files:/);
    assert.match(handoff, /run_record_index: recommended_default -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json/);
    assert.match(handoff, /production_signoff_packet: recommended_default -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /launch_duty_archive_index: recommended_default -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /Filled closeout input: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json/);
    assert.match(handoff, /Closeout review: not_loaded \(missing=7, safeForFullTest=no\)/);
    assert.match(handoff, /Ordered packet steps: generate_rehearsal_outputs, run_route_map_gate, run_backup_restore_drill, run_live_write_smoke, record_launch_mainline_evidence, backfill_filled_closeout_input, reload_closeout_input, run_full_test_window, production_signoff_review, launch_day_watch, stabilization_handoff/);
    assert.match(handoff, /Final packet go-live current blocker: staging_profile/);
    assert.match(handoff, /Final packet go-live action queue:/);
    assert.match(handoff, /staging_profile: load_profile \(command=npm\.cmd run staging:rehearsal -- --profile-file <staging-profile\.json>/);
    assert.match(handoff, /Final packet go-live operator action plan: status=blocked_until_real_staging_inputs, remaining=8/);
    assert.match(handoff, /Current go-live action: staging_profile \(phase=real_staging_inputs, kind=load_profile\)/);
    assert.match(handoff, /Phase real_staging_inputs: ready=1, blocked=3/);
    assert.match(handoff, /Post-signoff action checklist:/);
    assert.match(handoff, /production_signoff_packet: blocked_until_signoff_ready \(action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /expectedEvidence: Archive the signed production sign-off packet with full-test status, GO\/NO-GO decision, and receipt visibility lanes\./);
    assert.match(handoff, /launch_day_watch_summary: blocked_until_signoff_ready \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*receiptOperations: record_cutover_walkthrough, record_launch_day_readiness_review[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\./);
    assert.match(handoff, /launch_duty_archive_index: blocked_until_signoff_ready \(action=review_launch_duty_archive_index\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Launch-duty signoff targets:[\s\S]*production_signoff_packet: blocked_until_signoff_ready \(action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json[\s\S]*expectedEvidence: Archive the signed production sign-off packet with full-test status, GO\/NO-GO decision, and receipt visibility lanes\.[\s\S]*launch_day_watch_summary: blocked_until_signoff_ready \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*receiptOperations: record_cutover_walkthrough, record_launch_day_readiness_review[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\.[\s\S]*## Staging Environment Binding/);
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Watch artifacts:[\s\S]*launch_day_watch_summary: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*receiptOperations: record_cutover_walkthrough, record_launch_day_readiness_review[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\.[\s\S]*rollback_signal_review: blocked_until_production_signoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md[\s\S]*expectedEvidence: Record whether rollback signals were observed, dismissed, or escalated\.[\s\S]*## Staging Environment Binding/);
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Stabilization handoff windows:[\s\S]*stabilization_owner_handoff: blocked_until_cutover_watch \(T\+2h stabilization owner handoff\)[\s\S]*summary: Hand off launch-day watch summary, incidents, receipt snapshots, and rollback signals to the stabilization owner\.[\s\S]*receiptOperations: record_launch_stabilization_review[\s\S]*expectedEvidence: Record stabilization owner, timestamp, unresolved items, and next-duty follow-up\.[\s\S]*first_wave_closeout: blocked_until_stabilization_owner_handoff \(T\+24h first-wave closeout\)[\s\S]*receiptOperations: record_launch_closeout_review[\s\S]*expectedEvidence: Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp\.[\s\S]*## Staging Environment Binding/);
    assert.match(handoff, /## Artifact \/ Receipt Ledger/);
    assert.match(handoff, /artifacts\/staging\/PILOT_ALPHA\/stable/);
    assert.match(handoff, /launch_mainline_evidence_receipts/);
    assert.match(handoff, /record_recovery_drill, record_backup_verification/);
    assert.match(handoff, /## Staging Run Record Template[\s\S]*Records:[\s\S]*route_map_gate_result: artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt[\s\S]*expectedEvidence: Record the targeted gate exit status, pass count, and redacted output artifact path\.[\s\S]*launch_day_watch_summary: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\.[\s\S]*stabilization_owner_handoff: artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*expectedEvidence: Record stabilization owner, timestamp, unresolved items, and next-duty follow-up\.[\s\S]*first_wave_closeout: artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*expectedEvidence: Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp\.[\s\S]*## Staging Rehearsal Run Record Index/);
    assert.match(handoff, /## Staging Rehearsal Run Record Index[\s\S]*Record groups:[\s\S]*pre_full_test_closeout: awaiting_operator_evidence \(records=7\)[\s\S]*route_map_gate_result: stagingAcceptanceCloseout -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt[\s\S]*expectedEvidence: Record the targeted gate exit status, pass count, and redacted output artifact path\.[\s\S]*launch_day_watch_and_stabilization: blocked_until_production_signoff \(records=6\)[\s\S]*launch_day_watch_summary: launchDayWatchPlan -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*expectedEvidence: Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions\.[\s\S]*stabilization_owner_handoff: stabilizationHandoffPlan -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*expectedEvidence: Record stabilization owner, timestamp, unresolved items, and next-duty follow-up\.[\s\S]*first_wave_closeout: stabilizationHandoffPlan -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*expectedEvidence: Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp\.[\s\S]*## Staging Launch Duty Archive Index/);
    assert.match(handoff, /## Full Test Window Entry/);
    assert.match(handoff, /Command: `npm\.cmd test`/);
    assert.match(handoff, /blocked_until_staging_closeout/);
    assert.match(handoff, /Do not run the full suite/);
    assert.match(handoff, /## Production Sign-Off Conditions/);
    assert.match(handoff, /blocked_until_full_test_window/);
    assert.match(handoff, /ready-for-production-signoff/);
    assert.match(handoff, /## Operator Execution Plan/);
    assert.match(handoff, /Operator real staging input closure: blocked_until_profile_and_paths \(ready=1, blocked=4\)/);
    assert.match(handoff, /Operator real input staging_profile: missing/);
    assert.match(handoff, /Operator real input artifact_archive_root: ready/);
    assert.match(handoff, /Operator go-live action plan: status=blocked_until_real_staging_inputs, remaining=8/);
    assert.match(handoff, /Operator current go-live action: staging_profile \(phase=real_staging_inputs, kind=load_profile\)/);
    assert.match(handoff, /Operator phase real_staging_inputs: ready=1, blocked=3/);
    assert.match(handoff, /Closeout backfill focus: awaiting_closeout_backfill \(missing=7, current=route_map_gate_result\)/);
    assert.match(handoff, /Closeout reload execution entry: awaiting_backfill \(current=route_map_gate_result, queue=7\/7\)/);
    assert.match(handoff, /Closeout reload first queue item: route_map_gate_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /Closeout reload post-reload review: readiness_review_packet \(fullTest=no, command=npm\.cmd test\)/);
    assert.match(handoff, /Closeout reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /Current closeout artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /Launch-duty packet focus: closeout_reload_packet \(awaiting_closeout_backfill\)/);
    assert.match(handoff, /Launch-duty current packet path: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-closeout-reload-packet\.json/);
    assert.match(handoff, /Launch-duty packet sequence: run_record_index -> artifact_manifest -> backup_restore_packet -> closeout_reload_packet -> readiness_review_packet -> production_signoff_packet/);
    assert.match(handoff, /review_generated_bundle/);
    assert.match(handoff, /backfill_closeout_template/);
    assert.match(handoff, /production_signoff_review/);
    assert.match(handoff, /Readiness gaps/);
    assert.match(handoff, /closeout_backfill_pending/);
    assert.match(handoff, /developer_bearer_token_missing/);
    assert.match(handoff, /missingReceiptVisibilityKeys: launchMainline, launchReview, launchSmoke, developerOps, launchOpsOverviewStatus/);
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
    assert.equal(template.stagingRehearsalExecutionSummary.status, "profile_not_loaded");
    assert.equal(template.stagingRehearsalRunRecordIndex.status, "awaiting_evidence_backfill");
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
    assert.deepEqual(Object.keys(template.receiptVisibility), expectedReceiptVisibilityKeys);
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
    assert.deepEqual(template.closeoutBackfillGuide.receiptVisibilityKeys, expectedReceiptVisibilityKeys);
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
    assert.deepEqual(template.productionSignoffReadiness.missingReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
    assert.equal(template.launchDayWatchPlan.status, "blocked");
    assert.equal(template.launchDayWatchPlan.canStartCutoverWatch, false);
    assert.deepEqual(
      template.launchDayWatchPlan.watchWindows.map((item) => item.key),
      ["cutover_watch", "first_wave_stabilization"]
    );
    assert.deepEqual(template.launchDayWatchPlan.missingReceiptVisibilityKeys, expectedReceiptVisibilityKeys);
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
    assert.deepEqual(template.stagingRunRecordTemplate.requiredRecordKeys.slice(-6), [
      "launch_day_watch_summary",
      "first_wave_incident_log",
      "receipt_visibility_snapshot",
      "rollback_signal_review",
      "stabilization_owner_handoff",
      "first_wave_closeout"
    ]);
    assert.equal(
      template.stagingRunRecordTemplate.records.find((item) => item.key === "stabilization_owner_handoff").artifactPath,
      "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"
    );
    assert.equal(template.stagingRehearsalRunRecordIndex.status, "awaiting_evidence_backfill");
    assert.equal(template.stagingRehearsalRunRecordIndex.closeoutProgress.missingRecordCount, 7);
    assert.deepEqual(
      template.stagingRehearsalRunRecordIndex.recordGroups.map((item) => [item.key, item.status]),
      [
        ["pre_full_test_closeout", "awaiting_operator_evidence"],
        ["production_signoff", "blocked_until_full_test_window"],
        ["launch_day_watch_and_stabilization", "blocked_until_production_signoff"]
      ]
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
    assert.equal(template.finalRehearsalPacket.goLiveCurrentBlocker.key, "staging_profile");
    assert.equal(template.finalRehearsalPacket.goLiveActionQueue.find((item) => item.key === "filled_closeout_input").operatorAction.kind, "create_file");
    assert.equal(template.finalRehearsalPacket.goLiveOperatorActionPlan.currentAction.key, "staging_profile");
    assert.equal(template.finalRehearsalPacket.goLiveOperatorActionPlan.actions.find((item) => item.key === "production_signoff").phase, "production_signoff");
    assert.equal(template.operatorExecutionPlan.status, "ready_for_staging_execution");
    assert.equal(template.operatorExecutionPlan.realStagingInputClosure.status, "blocked_until_profile_and_paths");
    assert.equal(template.operatorExecutionPlan.realStagingInputClosure.blockedCheckCount, 4);
    assert.equal(template.operatorExecutionPlan.goLiveOperatorActionPlan.currentAction.key, "staging_profile");
    assert.equal(template.operatorExecutionPlan.goLiveOperatorActionPlan.remainingActionCount, 8);
    assert.equal(template.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget.key, "route_map_gate_result");
    assert.equal(template.operatorExecutionPlan.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(template.operatorExecutionPlan.launchDutyCurrentAction.stage, "closeout_backfill");
    assert.equal(template.operatorExecutionPlan.launchDutyCurrentAction.sourceFocus, "closeoutBackfillFocus");
    assert.equal(template.operatorExecutionPlan.launchDutyCurrentAction.key, "route_map_gate_result");
    assert.equal(template.operatorExecutionPlan.launchDutyCurrentAction.packetPath, "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json");
    assert.equal(
      template.operatorExecutionPlan.closeoutBackfillFocus.paths.filledCloseoutInputFile,
      "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
    );
    assert.equal(
      template.operatorExecutionPlan.closeoutBackfillFocus.reloadCommand,
      "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
    );
    assert.equal(template.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.key, "closeout_reload_packet");
    assert.equal(
      template.operatorExecutionPlan.launchDutyPacketFocus.archiveIndexPath,
      "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"
    );
    assert.equal(
      template.operatorExecutionPlan.launchDutyPacketFocus.packetSequence.find((item) => item.key === "readiness_review_packet").path,
      "artifacts/staging/PILOT_ALPHA/stable/staging-readiness-review-packet.json"
    );
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
      decision: null,
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
          value: {
            decision: "ready-for-full-test-window",
            operator: "launch-duty",
            summary: "redacted go/no-go approval"
          }
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
    assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.status, "ready_for_full_test_window");
    assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.missingFieldCount, 0);
    assert.deepEqual(output.operatorExecutionPlan.closeoutBackfillFocus.missingBackfillKeys, []);
    assert.equal(output.operatorExecutionPlan.closeoutBackfillFocus.currentBackfillTarget, null);
    assert.deepEqual(output.operatorExecutionPlan.closeoutBackfillFocus.operatorGoNoGoResultCaptureEntry, {
      mode: "operator-go-no-go-result-capture-entry",
      key: "operator_go_no_go",
      status: "filled",
      willModifyData: false,
      currentActionKey: "reload_closeout_input",
      currentCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      decision: "ready-for-full-test-window",
      requiredDecision: "ready-for-full-test-window",
      allowedDecisions: ["ready-for-full-test-window", "hold", "rollback-follow-up"],
      resultBackfillTarget: {
        key: "operator_go_no_go",
        status: "filled",
        closeoutInputPath: closeoutInputFile,
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md",
        sourceStep: "backfill_filled_closeout_input",
        receiptOperations: [],
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
      },
      nextAction: "Reload closeout input and continue full-test readiness review."
    });
    assert.deepEqual(
      output.operatorExecutionPlan.closeoutBackfillFocus.postLiveWriteResultCaptureEntries.map((item) => [
        item.key,
        item.status,
        item.currentActionKey,
        item.currentCommand,
        item.resultBackfillTarget.closeoutInputPath,
        item.resultBackfillTarget.reloadCommand
      ]),
      [
        ["launch_smoke_handoff", "filled", "reload_closeout_input", `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`, closeoutInputFile, `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`],
        ["launch_mainline_evidence_receipts", "filled", "reload_closeout_input", `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`, closeoutInputFile, `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`],
        ["receipt_visibility_review", "filled", "reload_closeout_input", `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`, closeoutInputFile, `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`]
      ]
    );
    assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.status, "ready_for_closeout_reload");
    assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentCaptureKey, null);
    assert.equal(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentActionKey, "reload_closeout_input");
    assert.equal(
      output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.currentCommand,
      `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`
    );
    assert.deepEqual(output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.closeoutReload, {
      status: "ready",
      command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      closeoutInputPath: closeoutInputFile
    });
    assert.deepEqual(
      output.stagingCloseoutReloadPacket.postLiveWriteExecutionEntry.captureQueue.map((item) => [item.key, item.status]),
      [
        ["launch_smoke_handoff", "filled"],
        ["launch_mainline_evidence_receipts", "filled"],
        ["receipt_visibility_review", "filled"]
      ]
    );
    assert.equal(output.stagingBackupRestoreDrillPacket.status, "backfilled_for_closeout_reload");
    assert.deepEqual(output.stagingBackupRestoreDrillPacket.closeoutBackfill, {
      status: "filled",
      closeoutInputStatus: "loaded",
      closeoutInputPath: closeoutInputFile,
      sourceStep: "run_backup_restore_drill",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
      receiptOperations: [],
      nextAction: "Keep backup_restore_drill_result in the filled closeout input and reload closeout readiness."
    });
    assert.equal(
      output.stagingBackupRestoreDrillPacket.operatorSteps.find((item) => item.key === "backfill_closeout_key").status,
      "ready"
    );
    assert.equal(output.stagingBackupRestoreDrillPacket.nextAction, "Backup/restore evidence is backfilled; reload closeout input and review full-test readiness.");
    assert.deepEqual(output.stagingBackupRestoreDrillPacket.resultCaptureEntry, {
      mode: "backup-restore-result-capture-entry",
      status: "ready_for_closeout_reload",
      willModifyData: false,
      currentActionKey: "reload_closeout_input",
      currentCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      commandKeys: [
        "appBackup",
        "postgresBackup",
        "postgresRestoreDryRun",
        "restoreDrillReminder",
        "healthcheck"
      ],
      resultBackfillTarget: {
        key: "backup_restore_drill_result",
        status: "filled",
        closeoutInputPath: closeoutInputFile,
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
        sourceStep: "run_backup_restore_drill",
        receiptOperations: ["record_recovery_drill", "record_backup_verification"],
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
      },
      receiptTargets: [
        { operation: "record_recovery_drill", status: "recorded_or_attached" },
        { operation: "record_backup_verification", status: "recorded_or_attached" }
      ],
      nextAction: "Reload closeout input and continue full-test readiness review."
    });
    assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.status, "ready_for_closeout_reload");
    assert.equal(output.stagingBackupRestoreDrillPacket.executionEntry.currentActionKey, "reload_closeout_input");
    assert.equal(
      output.stagingBackupRestoreDrillPacket.executionEntry.currentCommand,
      `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`
    );
    assert.deepEqual(output.stagingBackupRestoreDrillPacket.executionEntry.closeoutReload, {
      status: "ready",
      command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      closeoutInputPath: closeoutInputFile
    });
    assert.deepEqual(
      output.stagingBackupRestoreDrillPacket.executionEntry.receiptQueue.map((item) => [item.operation, item.status]),
      [
        ["record_recovery_drill", "recorded_or_attached"],
        ["record_backup_verification", "recorded_or_attached"]
      ]
    );
    assert.deepEqual(output.stagingCloseoutReloadPacket.backupRestoreGate, {
      status: "ready",
      packetStatus: "backfilled_for_closeout_reload",
      closeoutKey: "backup_restore_drill_result",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
      closeoutInputPath: closeoutInputFile,
      nextAction: "Backup/restore evidence is backfilled; continue closeout reload and full-test readiness review."
    });
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.mode, "full-test-signoff-focus");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.status, "ready_for_full_test_window");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.canSignoffProduction, false);
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.key, "backfill_production_signoff");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.status, "ready_for_full_test_window");
    assert.equal(
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.followUpBackfillCommand,
      `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md`
    );
    assert.equal(
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.statusCommand,
      `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md`
    );
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.commands.fullTestWindow, "npm.cmd test");
    assert.equal(
      output.operatorExecutionPlan.fullTestSignoffFocus.commands.signoffBackfill,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.followUpBackfillCommand
    );
    assert.equal(
      output.operatorExecutionPlan.fullTestSignoffFocus.commands.readinessStatus,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.statusCommand
    );
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.status, "ready_for_full_test_window");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentPhase, "full_test_window_entry");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.sourceFocus, "fullTestSignoffFocus");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentActionKey, "run_full_test_window");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentCommand, "npm.cmd test");
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.commands.signoffBackfill,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.followUpBackfillCommand
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.commands.readinessStatus,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.statusCommand
    );
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.canSignoffProduction, false);
    assert.deepEqual(output.operatorExecutionPlan.realStagingRunFocus.liveWriteSmokeResultCaptureEntry, {
      mode: "live-write-smoke-result-capture-entry",
      status: "ready_for_closeout_reload",
      willModifyData: false,
      commandWillModifyData: true,
      currentActionKey: "reload_closeout_input",
      currentCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      approval: {
        required: true,
        sourceStep: "approve_live_write_smoke",
        status: "already_approved_or_attached"
      },
      resultBackfillTarget: {
        key: "live_write_smoke_result",
        status: "filled",
        closeoutInputPath: closeoutInputFile,
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json",
        sourceStep: "run_live_write_smoke",
        receiptOperations: ["record_launch_rehearsal_run"],
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
      },
      receiptTargets: [
        { operation: "record_launch_rehearsal_run", status: "recorded_or_attached" }
      ],
      nextAction: "Reload closeout input and continue full-test readiness review."
    });
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.blockerSummary.missingCloseoutKeys.length, 0);
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.blockerSummary.missingSignoffKeys,
      expectedProductionSignoffConditionKeys
    );
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.blockerSummary.missingReceiptVisibilityKeys,
      expectedReceiptVisibilityKeys
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.paths.productionSignoffPacketFile,
      "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"
    );
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.stage, "full_test_signoff");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.sourceFocus, "fullTestSignoffFocus");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.key, "backfill_production_signoff");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.status, "ready_for_full_test_window");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.command, "npm.cmd test");
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.followUpBackfillCommand,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.followUpBackfillCommand
    );
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.statusCommand,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.statusCommand
    );
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.packetPath,
      "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"
    );
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.evidenceInputs.map((item) => [item.key, item.kind, item.status, item.path || item.command]),
      [
        ["full_test_window", "command", "ready_for_full_test_window", "npm.cmd test"],
        ["production_signoff_packet", "packet", "ready_for_operator_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["filled_closeout_input", "file", "loaded", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.confirmationPoints.map((item) => [item.key, item.status]),
      [
        ["production_signoff_conditions", "missing"],
        ["receipt_visibility", "missing"],
        ["reload_closeout_input", "operator_execute"]
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.archiveTrace, {
      archiveRoot: "artifacts/staging/PILOT_ALPHA/stable",
      runRecordIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json",
      launchDutyArchiveIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json",
      currentPacketPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      currentRecordGroupKey: "production_signoff",
      currentRecordGroupStatus: "blocked_until_full_test_window",
      runRecordIndexStatus: "ready_for_full_test_window",
      launchDutyArchiveStatus: "awaiting_archive_review"
    });
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.recordUpdates.map((item) => [item.key, item.groupKey, item.status, item.path || item.command]),
      [
        ["full_test_window", "production_signoff", "ready_for_full_test_window", "npm.cmd test"],
        ["production_signoff_packet", "production_signoff", "ready_for_operator_backfill", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["filled_closeout_input", "production_signoff", "loaded", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"]
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.fullTestSignoffFocus.missingCloseoutKeys, []);
    assert.deepEqual(
      output.operatorExecutionPlan.fullTestSignoffFocus.missingSignoffKeys,
      expectedProductionSignoffConditionKeys
    );
    assert.deepEqual(
      output.operatorExecutionPlan.fullTestSignoffFocus.missingReceiptVisibilityKeys,
      expectedReceiptVisibilityKeys
    );
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.key, "readiness_review_packet");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.status, "ready_for_full_test_window");
    assert.equal(output.fullTestWindowReadiness.status, "ready");
    assert.equal(output.fullTestWindowReadiness.canRun, true);
    assert.deepEqual(output.fullTestWindowReadiness.missingCloseoutKeys, []);
    assert.deepEqual(output.fullTestWindowReadiness.closeoutEvidenceTargets, expectedCloseoutEvidenceTargets([]));
    assert.deepEqual(output.fullTestWindowReadiness.resultCaptureEntry, {
      mode: "full-test-result-capture-entry",
      status: "ready_for_full_test_result_capture",
      willModifyData: false,
      currentActionKey: "run_full_test_window",
      currentCommand: "npm.cmd test",
      resultBackfillTarget: {
        key: "full_test_window_passed",
        status: "pending_operator_result",
        closeoutInputPath: closeoutInputFile,
        reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
        expectedEvidence: "Attach the full `npm.cmd test` output summary and failure count."
      },
      productionSignoffTarget: {
        requiredDecision: "ready-for-production-signoff",
        currentSignoffKey: "full_test_window_passed"
      },
      nextAction: "Run npm.cmd test, capture the redacted summary, backfill full_test_window_passed, then reload closeout input."
    });
    assert.deepEqual(output.productionSignoffReadiness.signoffEvidenceTargets, expectedSignoffEvidenceTargets());
    assert.deepEqual(output.productionSignoffReadiness.receiptVisibilityEvidenceTargets, expectedReceiptVisibilityEvidenceTargets());
    assert.deepEqual(
      output.productionSignoffReadiness.evidenceCaptureEntries.map((item) => [
        item.key,
        item.category,
        item.status,
        item.currentActionKey,
        item.currentCommand,
        item.resultBackfillTarget.productionSignoffPacketFile,
        item.resultBackfillTarget.closeoutInputPath
      ]),
      [
        ["full_test_window_passed", "signoff_condition", "pending_operator_evidence", "run_full_test_window", "npm.cmd test", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["staging_artifacts_archived", "signoff_condition", "pending_operator_evidence", "archive_staging_artifacts", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launch_mainline_receipts_visible", "signoff_condition", "pending_operator_evidence", "verify_launch_mainline_receipts", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launch_ops_overview_status_visible", "signoff_condition", "pending_operator_evidence", "verify_launch_ops_overview_status", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["backup_restore_drill_passed", "signoff_condition", "pending_operator_evidence", "review_backup_restore_drill", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["rollback_path_confirmed", "signoff_condition", "pending_operator_evidence", "confirm_rollback_path", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["operator_signoff_recorded", "signoff_condition", "pending_operator_evidence", "record_operator_signoff", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchMainline", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchReview", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchSmoke", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["developerOps", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchOpsOverviewStatus", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.fullTestSignoffFocus.productionSignoffEvidenceCaptureEntries,
      output.productionSignoffReadiness.evidenceCaptureEntries
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceCaptureEntries,
      output.productionSignoffReadiness.evidenceCaptureEntries
    );
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.mode, "production-signoff-evidence-execution-entry");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.status, "awaiting_production_signoff_evidence");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.willModifyData, false);
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentEvidenceKey, "full_test_window_passed");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentActionKey, "run_full_test_window");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentCommand, "npm.cmd test");
    assert.deepEqual(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.evidenceQueue.map((item) => [
        item.key,
        item.category,
        item.status,
        item.currentActionKey,
        item.currentCommand,
        item.productionSignoffPacketFile,
        item.closeoutInputPath
      ]),
      [
        ["full_test_window_passed", "signoff_condition", "pending_operator_evidence", "run_full_test_window", "npm.cmd test", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["staging_artifacts_archived", "signoff_condition", "pending_operator_evidence", "archive_staging_artifacts", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launch_mainline_receipts_visible", "signoff_condition", "pending_operator_evidence", "verify_launch_mainline_receipts", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launch_ops_overview_status_visible", "signoff_condition", "pending_operator_evidence", "verify_launch_ops_overview_status", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["backup_restore_drill_passed", "signoff_condition", "pending_operator_evidence", "review_backup_restore_drill", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["rollback_path_confirmed", "signoff_condition", "pending_operator_evidence", "confirm_rollback_path", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["operator_signoff_recorded", "signoff_condition", "pending_operator_evidence", "record_operator_signoff", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchMainline", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchReview", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchSmoke", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["developerOps", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile],
        ["launchOpsOverviewStatus", "receipt_visibility", "pending_visibility_review", "verify_receipt_visibility", null, "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json", closeoutInputFile]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.signoffConditionQueue.map((item) => [item.key, item.status]),
      [
        ["full_test_window_passed", "pending_operator_evidence"],
        ["staging_artifacts_archived", "pending_operator_evidence"],
        ["launch_mainline_receipts_visible", "pending_operator_evidence"],
        ["launch_ops_overview_status_visible", "pending_operator_evidence"],
        ["backup_restore_drill_passed", "pending_operator_evidence"],
        ["rollback_path_confirmed", "pending_operator_evidence"],
        ["operator_signoff_recorded", "pending_operator_evidence"]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.receiptVisibilityQueue.map((item) => [item.key, item.status]),
      [
        ["launchMainline", "pending_visibility_review"],
        ["launchReview", "pending_visibility_review"],
        ["launchSmoke", "pending_visibility_review"],
        ["developerOps", "pending_visibility_review"],
        ["launchOpsOverviewStatus", "pending_visibility_review"]
      ]
    );
    assert.deepEqual(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.closeoutReload, {
      status: "blocked_until_production_signoff_backfill",
      command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      closeoutInputPath: closeoutInputFile
    });
    assert.equal(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentBackfillCommand,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.followUpBackfillCommand
    );
    assert.equal(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.statusCommand,
      output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.statusCommand
    );
    assert.equal(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.nextAction,
      "Backfill full_test_window_passed, reload closeout input, then re-check production sign-off readiness."
    );
    assert.deepEqual(
      output.operatorExecutionPlan.fullTestSignoffFocus.productionSignoffEvidenceExecutionEntry,
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry
    );
    assert.equal(output.fullTestWindowReadiness.nextAction, "Run npm.cmd test in the reserved full test window, then backfill productionSignoff.");
    assert.equal(output.stagingReadinessTransition.status, "ready_for_full_test_window");
    assert.deepEqual(output.stagingReadinessReviewPacket.fullTestEntryExecution, {
      mode: "full-test-entry-execution",
      status: "ready_for_full_test_window",
      willModifyData: false,
      currentActionKey: "run_full_test_window",
      currentCommand: "npm.cmd test",
      closeoutReload: {
        status: "ready_for_full_test_window",
        command: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
        packetFile: "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-reload-packet.json",
        missingCloseoutKeys: []
      },
      fullTestWindow: {
        status: "ready",
        canRun: true,
        command: "npm.cmd test",
        missingCloseoutKeys: []
      },
      postFullTest: {
        targetPacketKey: "production_signoff_packet",
        packetFile: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
        requiredDecision: "ready-for-production-signoff",
        missingSignoffKeys: expectedProductionSignoffConditionKeys,
        missingReceiptVisibilityKeys: expectedReceiptVisibilityKeys
      },
      nextAction: "Run npm.cmd test, then backfill production sign-off evidence into the production sign-off packet."
    });
    assert.equal(output.stagingRehearsalExecutionSummary.status, "ready_for_full_test_window");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.closeoutMissingFieldCount, 0);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.canEnterFullTestWindow, true);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.stage, "full_test_signoff");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.key, "backfill_production_signoff");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.stage, "full_test_signoff");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.key, "backfill_production_signoff");
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.checks.map((item) => [item.key, item.status]),
      [
        ["staging_profile", "missing"],
        ["required_secret_env", "missing"],
        ["artifact_output_paths", "missing"],
        ["artifact_archive_root", "ready"],
        ["filled_closeout_input", "ready"]
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.realStagingInputClosure.status, "blocked_until_profile_and_paths");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.status, "blocked_until_real_staging_inputs");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.readyCheckCount, 3);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.blockedCheckCount, 6);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.scriptReadinessPercent, 33);
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.blockedQueue.map((item) => item.key),
      [
        "staging_profile",
        "required_secret_env",
        "artifact_output_paths",
        "production_signoff",
        "launch_day_watch",
        "stabilization_handoff"
      ]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.currentBlocker.key, "staging_profile");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.currentBlocker.operatorAction.kind, "load_profile");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.blockedQueue.find((item) => item.key === "production_signoff").operatorAction.command, "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>");
    assert.equal(
      output.stagingRehearsalExecutionSummary.operatorFocus.goLiveProgress.nextAction,
      "Clear the real staging input closure, then rerun the no-write staging rehearsal."
    );
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.remainingBlockers.map((item) => item.key),
      ["production_signoff_not_ready", "launch_day_watch_not_ready", "stabilization_handoff_not_ready"]
    );
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.status, "awaiting_production_signoff");
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure.nextPlan.map((item) => item.key),
      [
        "run_full_test_window",
        "backfill_production_signoff",
        "start_launch_day_watch",
        "prepare_stabilization_handoff"
      ]
    );
    assert.deepEqual(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyFocus, {
      status: "blocked_until_signoff_backfill",
      postSignoffActionCount: 8,
      blockedPostSignoffActionCount: 8,
      readyPostSignoffActionCount: 0,
      watchArtifactCount: 5,
      pendingWatchArtifactCount: 0,
      blockedWatchArtifactCount: 5,
      firstPostSignoffAction: "production_signoff_packet",
      nextAction: "Run the full test window and backfill production sign-off before launch-day watch."
    });
    assert.deepEqual(
      output.stagingRehearsalExecutionSummary.blockingReasons.map((item) => item.key),
      ["production_signoff_pending"]
    );
    assert.equal(output.stagingRehearsalRunRecordIndex.status, "ready_for_full_test_window");
    assert.equal(output.stagingRehearsalRunRecordIndex.closeoutProgress.missingRecordCount, 0);
    assert.deepEqual(output.stagingRehearsalRunRecordIndex.closeoutProgress.filledRecordKeys, output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key));
    assert.deepEqual(
      output.stagingRehearsalRunRecordIndex.recordGroups.map((item) => [item.key, item.status]),
      [
        ["pre_full_test_closeout", "ready_for_full_test_window"],
        ["production_signoff", "blocked_until_full_test_window"],
        ["launch_day_watch_and_stabilization", "blocked_until_production_signoff"]
      ]
    );
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
    const handoffFile = join(tempDir, "signoff-ready-handoff.md");
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
    const signoffConditions = expectedProductionSignoffConditionKeys.map((key) => ({
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
        },
        launchOpsOverviewStatus: {
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
      closeoutInputFile,
      "--handoff-file",
      handoffFile
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
    assert.deepEqual(output.fullTestWindowReadiness.closeoutEvidenceTargets, expectedCloseoutEvidenceTargets([]));
    assert.deepEqual(output.productionSignoffReadiness.signoffEvidenceTargets, expectedSignoffEvidenceTargets([]));
    assert.deepEqual(output.productionSignoffReadiness.receiptVisibilityEvidenceTargets, expectedReceiptVisibilityEvidenceTargets([]));
    assert.deepEqual(
      output.closeoutInput.signoffFilledKeys,
      output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key)
    );
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "closeout_file_not_requested"
      ]
    );
    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, /Full-test signoff focus: ready_for_launch_day_watch \(fullTest=yes, signoff=yes\)/);
    assert.match(handoff, /Full-test signoff action: archive_production_signoff \(ready_for_launch_day_watch\)/);
    assert.match(handoff, /Full-test signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /Execution launch-duty current action: archive_production_signoff \(stage=launch_day_watch_entry, source=launchDutyPacketFocus\)/);
    assert.match(handoff, /Final packet launch-duty current action: archive_production_signoff \(stage=launch_day_watch_entry, source=launchDutyPacketFocus\)/);
    assert.match(handoff, /Launch-duty current action: archive_production_signoff \(stage=launch_day_watch_entry, source=launchDutyPacketFocus\)/);
    assert.match(handoff, /Launch-duty current packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /Launch-duty evidence inputs: production_signoff_packet=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json; launch_day_watch_summary=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Launch-duty confirmation points: production_signoff_packet=archive_before_cutover; launch_day_watch_summary=pending_operator_entry; stabilization_owner_handoff=operator_handoff/);
    assert.match(handoff, /Launch-duty follow-up watch record: launch_day_watch_summary -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /Launch-duty follow-up watch action: launch_day_watch_summary \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /Launch-duty follow-up watch receipts: launch_day_watch_summary=record_cutover_walkthrough:pending_operator_receipt, launch_day_watch_summary=record_launch_day_readiness_review:pending_operator_receipt/);
    assert.match(handoff, /Launch-duty follow-up first-wave closeout: first_wave_closeout -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Launch-duty follow-up first-wave action: first_wave_closeout \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Launch-duty stabilization next action: Record stabilization owner handoff, then close first-wave stabilization\./);
    assert.match(handoff, /Go-live launch-day watch entry: ready_for_launch_day_watch \(target=production_signoff_packet, watch=launch_day_watch_summary, stabilization=stabilization_owner_handoff\)/);
    assert.match(handoff, /Go-live launch-day evidence inputs: production_signoff_packet=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json; launch_day_watch_summary=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Go-live launch-day watch records: launch_day_watch_summary=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; receipt_visibility_snapshot=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt; first_wave_incident_log=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Go-live launch-day receipt operations: launch_day_watch_summary=record_cutover_walkthrough, record_launch_day_readiness_review; receipt_visibility_snapshot=record_post_launch_ops_sweep; first_wave_incident_log=record_post_launch_ops_sweep; rollback_signal_review=record_rollback_walkthrough, record_launch_stabilization_review; stabilization_owner_handoff=record_launch_stabilization_review/);
    assert.match(handoff, /Go-live launch-day expected evidence: launch_day_watch_summary=Record cutover watch start\/end time, owner, route checks, and launch-day operator decisions.; receipt_visibility_snapshot=Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots.; first_wave_incident_log=Record first-wave incidents, customer impact, mitigation, owner, and status.; rollback_signal_review=Record whether rollback signals were observed, dismissed, or escalated.; stabilization_owner_handoff=Record stabilization owner, timestamp, unresolved items, and next-duty follow-up./);
    assert.match(handoff, /Go-live launch-day evidence current: launch_day_watch_summary \(action=record_launch_day_watch_summary, path=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md\)/);
    assert.match(handoff, /Go-live launch-day evidence stabilization: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Go-live launch-day stabilization handoff: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Go-live launch-day first-wave closeout: first_wave_closeout -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Go-live launch-day archive trace: group=launch_day_watch_and_stabilization, runRecord=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json, archiveIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /Execution launch-duty archive trace: group=launch_day_watch_and_stabilization, runRecord=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json, archiveIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /Final packet launch-duty record updates: production_signoff_packet=archive_before_cutover -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json; launch_day_watch_summary=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md; stabilization_owner_handoff=operator_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /Final packet launch-duty follow-up watch record: launch_day_watch_summary -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /Final packet launch-duty follow-up watch action: launch_day_watch_summary \(action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /Final packet launch-duty follow-up first-wave closeout: first_wave_closeout -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Final packet launch-duty follow-up first-wave action: first_wave_closeout \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Launch-duty archive trace: group=launch_day_watch_and_stabilization, runRecord=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-run-record-index\.json, archiveIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(handoff, /Launch-duty packet focus: launch_duty_archive_index \(awaiting_archive_review\)/);
    assert.match(handoff, /Launch-duty post-signoff target: production_signoff_packet \(archive_before_cutover\)/);
    assert.match(handoff, /Launch-duty watch artifact: launch_day_watch_summary \(pending_operator_entry\)/);
    assert.match(handoff, /Launch-duty stabilization window: stabilization_owner_handoff \(operator_handoff\)/);
    assert.match(handoff, /Launch-duty packet next action: Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff\./);
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Next action: Archive production sign-off packet, record launch-day watch artifacts, and hand off stabilization owner records\./);
    assert.match(
      handoff,
      new RegExp(`Production signoff closeout gate: ready_for_launch_day_watch \\(loaded=${closeoutInputFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}, archive=artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input\\.json\\)`)
    );
    assert.match(
      handoff,
      new RegExp(`Launch-day watch bridge loaded closeout input: ${closeoutInputFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`)
    );
    assert.match(
      handoff,
      new RegExp(`Launch-day watch loaded closeout input: ${closeoutInputFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`)
    );
    assert.match(
      handoff,
      new RegExp(`Watch draft loaded closeout input: ${closeoutInputFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`)
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.readinessSummary.canSignoffProduction, true);
    assert.equal(output.productionSignoffReadiness.status, "ready");
    assert.equal(output.productionSignoffReadiness.canSignoff, true);
    assert.equal(output.productionSignoffReadiness.productionDecision, "ready-for-production-signoff");
    assert.deepEqual(output.productionSignoffReadiness.missingSignoffKeys, []);
    assert.deepEqual(output.productionSignoffReadiness.missingReceiptVisibilityKeys, []);
    assert.equal(output.productionSignoffReadiness.nextAction, "Production sign-off is ready; keep the closeout artifact with release evidence before cutover.");
    assert.deepEqual(
      output.productionSignoffReadiness.evidenceCaptureEntries.map((item) => [
        item.key,
        item.category,
        item.status,
        item.currentActionKey,
        item.currentCommand
      ]),
      [
        ["full_test_window_passed", "signoff_condition", "filled", "archive_production_signoff", null],
        ["staging_artifacts_archived", "signoff_condition", "filled", "archive_production_signoff", null],
        ["launch_mainline_receipts_visible", "signoff_condition", "filled", "archive_production_signoff", null],
        ["launch_ops_overview_status_visible", "signoff_condition", "filled", "archive_production_signoff", null],
        ["backup_restore_drill_passed", "signoff_condition", "filled", "archive_production_signoff", null],
        ["rollback_path_confirmed", "signoff_condition", "filled", "archive_production_signoff", null],
        ["operator_signoff_recorded", "signoff_condition", "filled", "archive_production_signoff", null],
        ["launchMainline", "receipt_visibility", "visible", "archive_production_signoff", null],
        ["launchReview", "receipt_visibility", "visible", "archive_production_signoff", null],
        ["launchSmoke", "receipt_visibility", "visible", "archive_production_signoff", null],
        ["developerOps", "receipt_visibility", "visible", "archive_production_signoff", null],
        ["launchOpsOverviewStatus", "receipt_visibility", "visible", "archive_production_signoff", null]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceCaptureEntries,
      output.productionSignoffReadiness.evidenceCaptureEntries
    );
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.status, "ready_for_launch_day_watch");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentEvidenceKey, null);
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentActionKey, "archive_production_signoff");
    assert.equal(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.currentCommand, null);
    assert.equal(
      output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.evidenceQueue.every((item) => item.status === "filled" || item.status === "visible"),
      true
    );
    assert.deepEqual(output.stagingProductionSignoffPacket.productionSignoffEvidenceExecutionEntry.closeoutReload, {
      status: "ready",
      command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      closeoutInputPath: closeoutInputFile
    });
    assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Production signoff evidence execution entry: ready_for_launch_day_watch \(action=archive_production_signoff, current=-\)[\s\S]*Production signoff evidence queue: full_test_window_passed:filled, staging_artifacts_archived:filled[\s\S]*Production signoff receipt visibility queue: launchMainline:visible, launchReview:visible, launchSmoke:visible, developerOps:visible, launchOpsOverviewStatus:visible[\s\S]*Production signoff evidence reload: ready -> `npm\.cmd run staging:rehearsal -- --closeout-input-file/);
    assert.match(handoff, /## Production Sign-Off Readiness[\s\S]*Production sign-off evidence capture entries: 12[\s\S]*full_test_window_passed: filled \(signoff_condition, action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json[\s\S]*launchOpsOverviewStatus: visible \(receipt_visibility, action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(handoff, /## Staging Production Sign-Off Packet[\s\S]*Production sign-off evidence capture entries: 12[\s\S]*operator_signoff_recorded: filled \(signoff_condition, action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json[\s\S]*developerOps: visible \(receipt_visibility, action=archive_production_signoff\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.equal(output.launchDayWatchPlan.status, "ready");
    assert.equal(output.launchDayWatchPlan.canStartCutoverWatch, true);
    assert.equal(output.launchDayWatchPlan.loadedCloseoutInputPath, closeoutInputFile);
    assert.equal(output.launchDayWatchPlan.archiveCloseoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
    assert.deepEqual(output.launchDayWatchPlan.missingSignoffKeys, []);
    assert.deepEqual(output.launchDayWatchPlan.missingReceiptVisibilityKeys, []);
    assert.equal(output.launchDayWatchPlan.watchRecordDraft.status, "ready_for_operator_watch");
    assert.equal(output.launchDayWatchPlan.watchRecordDraft.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
    assert.equal(output.launchDayWatchPlan.watchRecordDraft.loadedCloseoutInputPath, closeoutInputFile);
    assert.equal(output.launchDayWatchPlan.watchRecordDraft.archiveCloseoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
    assert.equal(output.launchDayWatchPlan.watchRecordDraft.routes.launchMainline, output.nextCommands.launchMainline);
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.mode, "launch-day-watch-execution-entry");
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.status, "ready_for_operator_watch");
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentActionKey, "record_launch_day_watch_summary");
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.key, "launch_day_watch_summary");
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.status, "pending_operator_entry");
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.path, "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md");
    assert.deepEqual(output.launchDayWatchPlan.watchExecutionEntry.currentRecord.receiptOperations, ["record_cutover_walkthrough", "record_launch_day_readiness_review"]);
    assert.deepEqual(output.launchDayWatchPlan.watchExecutionEntry.stabilizationTarget, {
      key: "stabilization_owner_handoff",
      status: "pending_operator_entry",
      path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      receiptOperations: ["record_launch_stabilization_review"]
    });
    assert.equal(output.launchDayWatchPlan.watchExecutionEntry.nextAction, "Record launch-day watch summary, receipt visibility snapshot, incidents, rollback review, and stabilization owner handoff.");
    assert.deepEqual(
      output.launchDayWatchPlan.watchRecordDraft.records.map((item) => [item.key, item.status, item.artifactPath]),
      [
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["receipt_visibility_snapshot", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
        ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(
      output.launchDayWatchPlan.watchRecordDraft.records.find((item) => item.key === "launch_day_watch_summary").receiptOperations,
      ["record_cutover_walkthrough", "record_launch_day_readiness_review"]
    );
    assert.deepEqual(
      output.launchDayWatchPlan.watchEvidenceCaptureEntries.map((item) => [
        item.key,
        item.category,
        item.status,
        item.currentActionKey,
        item.currentCommand,
        item.resultBackfillTarget.artifactPath,
        item.receiptTargets.map((target) => target.operation)
      ]),
      [
        ["launch_day_watch_summary", "launch_day_watch_record", "pending_operator_entry", "record_launch_day_watch_summary", null, "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md", ["record_cutover_walkthrough", "record_launch_day_readiness_review"]],
        ["receipt_visibility_snapshot", "launch_day_watch_record", "pending_operator_entry", "record_receipt_visibility_snapshot", null, "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt", ["record_post_launch_ops_sweep"]],
        ["first_wave_incident_log", "launch_day_watch_record", "pending_operator_entry", "record_first_wave_incident_log", null, "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md", ["record_post_launch_ops_sweep"]],
        ["rollback_signal_review", "launch_day_watch_record", "pending_operator_entry", "record_rollback_signal_review", null, "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md", ["record_rollback_walkthrough", "record_launch_stabilization_review"]],
        ["stabilization_owner_handoff", "launch_day_watch_record", "pending_operator_entry", "handoff_stabilization_owner", null, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md", ["record_launch_stabilization_review"]]
      ]
    );
    assert.equal(
    output.launchDayWatchPlan.watchEvidenceCaptureEntries.every((item) => item.willModifyData === false),
    true
  );
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.mode, "launch-day-watch-evidence-execution-entry");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.status, "awaiting_launch_day_watch_evidence");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.willModifyData, false);
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentEvidenceKey, "launch_day_watch_summary");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentActionKey, "record_launch_day_watch_summary");
  assert.equal(output.launchDayWatchPlan.watchEvidenceExecutionEntry.currentCommand, null);
  assert.deepEqual(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.evidenceQueue.map((item) => [
      item.key,
      item.status,
      item.currentActionKey,
      item.artifactPath,
      item.receiptOperations
    ]),
    [
      ["launch_day_watch_summary", "pending_operator_entry", "record_launch_day_watch_summary", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md", ["record_cutover_walkthrough", "record_launch_day_readiness_review"]],
      ["receipt_visibility_snapshot", "pending_operator_entry", "record_receipt_visibility_snapshot", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt", ["record_post_launch_ops_sweep"]],
      ["first_wave_incident_log", "pending_operator_entry", "record_first_wave_incident_log", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md", ["record_post_launch_ops_sweep"]],
      ["rollback_signal_review", "pending_operator_entry", "record_rollback_signal_review", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md", ["record_rollback_walkthrough", "record_launch_stabilization_review"]],
      ["stabilization_owner_handoff", "pending_operator_entry", "handoff_stabilization_owner", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md", ["record_launch_stabilization_review"]]
    ]
  );
  assert.deepEqual(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.receiptQueue.map((item) => [item.key, item.operation, item.status, item.artifactPath]),
    [
      ["launch_day_watch_summary", "record_cutover_walkthrough", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["launch_day_watch_summary", "record_launch_day_readiness_review", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["receipt_visibility_snapshot", "record_post_launch_ops_sweep", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["first_wave_incident_log", "record_post_launch_ops_sweep", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["rollback_signal_review", "record_rollback_walkthrough", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["rollback_signal_review", "record_launch_stabilization_review", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "record_launch_stabilization_review", "pending_operator_receipt", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.deepEqual(output.launchDayWatchPlan.watchEvidenceExecutionEntry.stabilizationHandoff, {
    key: "stabilization_owner_handoff",
    status: "pending_operator_entry",
    path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
    receiptOperations: ["record_launch_stabilization_review"]
  });
  assert.equal(
    output.launchDayWatchPlan.watchEvidenceExecutionEntry.nextAction,
    "Record launch_day_watch_summary, attach receipt IDs, then continue launch-day watch evidence before stabilization handoff."
  );
  assert.match(handoff, /## Launch Day Watch Plan[\s\S]*Launch-day watch evidence execution entry: awaiting_launch_day_watch_evidence \(action=record_launch_day_watch_summary, current=launch_day_watch_summary\)[\s\S]*Launch-day watch evidence queue: launch_day_watch_summary:pending_operator_entry, receipt_visibility_snapshot:pending_operator_entry[\s\S]*Launch-day watch evidence receipt queue: launch_day_watch_summary=record_cutover_walkthrough:pending_operator_receipt, launch_day_watch_summary=record_launch_day_readiness_review:pending_operator_receipt[\s\S]*Launch-day watch evidence stabilization handoff: stabilization_owner_handoff -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
  assert.deepEqual(
    output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.watchRecordQueue?.map((item) => [item.key, item.receiptOperations]),
    [
        ["launch_day_watch_summary", ["record_cutover_walkthrough", "record_launch_day_readiness_review"]],
        ["receipt_visibility_snapshot", ["record_post_launch_ops_sweep"]],
        ["first_wave_incident_log", ["record_post_launch_ops_sweep"]],
        ["rollback_signal_review", ["record_rollback_walkthrough", "record_launch_stabilization_review"]],
        ["stabilization_owner_handoff", ["record_launch_stabilization_review"]]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.watchRecordQueue?.map((item) => [item.key, item.expectedEvidence]),
      [
        ["launch_day_watch_summary", "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
        ["receipt_visibility_snapshot", "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
        ["first_wave_incident_log", "Record first-wave incidents, customer impact, mitigation, owner, and status."],
        ["rollback_signal_review", "Record whether rollback signals were observed, dismissed, or escalated."],
        ["stabilization_owner_handoff", "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."]
      ]
    );
    assert.equal(output.launchDayWatchPlan.nextAction, "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility open.");
    assert.equal(output.stabilizationHandoffPlan.status, "ready");
    assert.equal(output.stabilizationHandoffPlan.canStartStabilizationHandoff, true);
    assert.equal(output.stabilizationHandoffPlan.sourceWatchStatus, "ready");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.mode, "stabilization-handoff-execution-entry");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.status, "ready_for_stabilization_handoff");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentActionKey, "handoff_stabilization_owner");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.key, "stabilization_owner_handoff");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.status, "operator_handoff");
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.path, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md");
    assert.deepEqual(output.stabilizationHandoffPlan.handoffExecutionEntry.currentHandoffTarget.receiptOperations, ["record_launch_stabilization_review"]);
    assert.deepEqual(
      output.stabilizationHandoffPlan.handoffExecutionEntry.sourceRecordQueue.map((item) => [item.key, item.status, item.path]),
      [
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["receipt_visibility_snapshot", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
        ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(output.stabilizationHandoffPlan.handoffExecutionEntry.firstWaveCloseoutTarget, {
      key: "first_wave_closeout",
      status: "operator_closeout",
      path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      receiptOperations: ["record_launch_closeout_review"]
    });
    assert.equal(output.stabilizationHandoffPlan.handoffExecutionEntry.nextAction, "Record stabilization owner handoff, then close first-wave stabilization.");
    assert.deepEqual(
      output.stabilizationHandoffPlan.watchEvidenceCaptureEntries,
      output.launchDayWatchPlan.watchEvidenceCaptureEntries
    );
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
    assert.equal(output.stagingProductionSignoffPacket.status, "ready_for_launch_day_watch");
    assert.deepEqual(output.stagingProductionSignoffPacket.decision, {
      requiredDecision: "ready-for-production-signoff",
      productionDecision: "ready-for-production-signoff",
      canSignoff: true,
      readyForFullTestWindow: true,
      closeoutInputStatus: "loaded"
    });
    assert.deepEqual(output.stagingProductionSignoffPacket.productionSignoffCloseoutGate, {
      status: "ready_for_launch_day_watch",
      closeoutInputStatus: "loaded",
      loadedCloseoutInputPath: closeoutInputFile,
      archiveCloseoutInputPath: "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
      requiredDecision: "ready-for-production-signoff",
      productionDecision: "ready-for-production-signoff",
      readyForFullTestWindow: true,
      readyForReceiptVisibility: true,
      missingSignoffKeys: [],
      missingReceiptVisibilityKeys: [],
      nextAction: "Production sign-off evidence is loaded from the actual closeout input; archive the sign-off packet and start launch-day watch."
    });
    assert.deepEqual(output.stagingProductionSignoffPacket.missingSignoffKeys, []);
    assert.deepEqual(output.stagingProductionSignoffPacket.missingReceiptVisibilityKeys, []);
    assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.status, "already_filled");
    assert.equal(output.stagingProductionSignoffPacket.signoffBackfillDraft.productionSignoff.decision, "ready-for-production-signoff");
    assert.equal(
      output.stagingProductionSignoffPacket.signoffBackfillDraft.productionSignoff.conditions.every((item) => item.status === "filled"),
      true
    );
    assert.equal(
      Object.values(output.stagingProductionSignoffPacket.signoffBackfillDraft.receiptVisibility).every((item) => item.value === "visible"),
      true
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.operatorSteps.map((item) => [item.key, item.status]),
      [
        ["run_full_test_window", "complete"],
        ["backfill_production_signoff", "complete"],
        ["verify_receipt_visibility", "complete"],
        ["reload_closeout_input", "operator_execute"],
        ["archive_production_signoff", "ready"],
        ["start_launch_day_watch", "ready"]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.postSignoffTargets.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "record_during_cutover_watch"],
        ["receipt_visibility_snapshot", "record_during_cutover_watch"],
        ["first_wave_incident_log", "record_during_cutover_watch"],
        ["rollback_signal_review", "record_during_cutover_watch"],
        ["launch_duty_archive_index", "archive_with_signoff"],
        ["stabilization_owner_handoff", "prepare_after_cutover_watch"],
        ["first_wave_closeout", "close_after_stabilization_handoff"]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.postSignoffTargets.map((item) => [item.key, item.currentActionKey]),
      [
        ["production_signoff_packet", "archive_production_signoff"],
        ["launch_day_watch_summary", "record_launch_day_watch_summary"],
        ["receipt_visibility_snapshot", "record_receipt_visibility_snapshot"],
        ["first_wave_incident_log", "record_first_wave_incident_log"],
        ["rollback_signal_review", "record_rollback_signal_review"],
        ["launch_duty_archive_index", "review_launch_duty_archive_index"],
        ["stabilization_owner_handoff", "handoff_stabilization_owner"],
        ["first_wave_closeout", "close_first_wave"]
      ]
    );
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.status, "ready_for_launch_day_watch");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.sourceStatus, "ready");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.watchRecordDraftStatus, "ready_for_operator_watch");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.productionDecision, "ready-for-production-signoff");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.loadedCloseoutInputPath, closeoutInputFile);
    assert.equal(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.archiveCloseoutInputPath,
      "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
    );
    assert.equal(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.productionSignoffCloseoutGate.status,
      "ready_for_launch_day_watch"
    );
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentPostSignoffTarget.key, "production_signoff_packet");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentWatchArtifact.key, "launch_day_watch_summary");
    assert.equal(output.stagingProductionSignoffPacket.launchDayWatchBridge.currentStabilizationWindow.key, "stabilization_owner_handoff");
    assert.deepEqual(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.evidenceInputs.map((item) => [item.key, item.status, item.path]),
      [
        ["production_signoff_packet", "archive_before_cutover", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["stabilization_owner_handoff", "operator_handoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.watchRecordQueue.map((item) => [item.key, item.status]),
      [
        ["launch_day_watch_summary", "pending_operator_entry"],
        ["receipt_visibility_snapshot", "pending_operator_entry"],
        ["first_wave_incident_log", "pending_operator_entry"],
        ["rollback_signal_review", "pending_operator_entry"],
        ["stabilization_owner_handoff", "pending_operator_entry"]
      ]
    );
    assert.deepEqual(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.stabilizationWindows.map((item) => [item.key, item.status]),
      [
        ["stabilization_owner_handoff", "operator_handoff"],
        ["first_wave_closeout", "operator_closeout"]
      ]
    );
    assert.equal(
      output.stagingProductionSignoffPacket.launchDayWatchBridge.nextAction,
      "Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff."
    );
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.mode, "production-signoff-execution-entry");
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.status, "ready_for_launch_day_watch");
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.currentActionKey, "archive_production_signoff");
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.currentCommand, null);
    assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.fullTestWindow, {
      status: "ready",
      canRun: true,
      command: "npm.cmd test"
    });
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.status, "already_filled");
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.currentSignoffKey, null);
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.currentReceiptVisibilityKey, null);
    assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.missingSignoffKeys, []);
    assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.signoffBackfill.missingReceiptVisibilityKeys, []);
    assert.deepEqual(output.stagingProductionSignoffPacket.signoffExecutionEntry.launchDayWatch, {
      status: "ready_for_launch_day_watch",
      currentTargetKey: "production_signoff_packet",
      nextAction: "Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff."
    });
    assert.equal(output.stagingProductionSignoffPacket.signoffExecutionEntry.nextAction, "Archive production sign-off packet, then start launch-day watch and stabilization handoff.");
    assert.equal(output.stagingProductionSignoffPacket.nextAction, "Archive production sign-off packet, then start launch-day watch and stabilization handoff.");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.key, "launch_duty_archive_index");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPacket.status, "awaiting_archive_review");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPostSignoffTarget.key, "production_signoff_packet");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentPostSignoffTarget.status, "archive_before_cutover");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentWatchArtifact.key, "launch_day_watch_summary");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentWatchArtifact.status, "pending_operator_entry");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentStabilizationWindow.key, "stabilization_owner_handoff");
    assert.equal(output.operatorExecutionPlan.launchDutyPacketFocus.currentStabilizationWindow.status, "operator_handoff");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.mode, "full-test-signoff-focus");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.status, "ready_for_launch_day_watch");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.canSignoffProduction, true);
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.key, "archive_production_signoff");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.currentAction.status, "ready_for_launch_day_watch");
    assert.equal(output.operatorExecutionPlan.fullTestSignoffFocus.signoffBackfillDraftStatus, "already_filled");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.currentPhase, "launch_watch_and_stabilization");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.status, "ready_for_launch_day_watch");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.currentPostSignoffTarget?.key, "production_signoff_packet");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.currentWatchArtifact?.key, "launch_day_watch_summary");
    assert.equal(output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.currentStabilizationWindow?.key, "stabilization_owner_handoff");
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.evidenceInputs?.map((item) => [item.key, item.status, item.path]),
      [
        ["production_signoff_packet", "archive_before_cutover", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["stabilization_owner_handoff", "operator_handoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry?.watchRecordQueue?.map((item) => [item.key, item.status, item.path]),
      [
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["receipt_visibility_snapshot", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
        ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.stage, "launch_day_watch_entry");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.sourceFocus, "launchDutyPacketFocus");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.key, "archive_production_signoff");
    assert.equal(output.operatorExecutionPlan.launchDutyCurrentAction.status, "ready_for_launch_day_watch");
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.packetPath,
      "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"
    );
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.evidenceInputs.map((item) => [item.key, item.kind, item.status, item.path]),
      [
        ["production_signoff_packet", "packet", "archive_before_cutover", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["launch_day_watch_summary", "artifact", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["stabilization_owner_handoff", "artifact", "operator_handoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpWatchRecord, {
      key: "launch_day_watch_summary",
      category: "launch_day_watch_record",
      status: "pending_operator_entry",
      currentActionKey: "record_launch_day_watch_summary",
      currentCommand: null,
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
      receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
      receiptTargets: [
        {
          operation: "record_cutover_walkthrough",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        },
        {
          operation: "record_launch_day_readiness_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        }
      ],
      expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."
      ,
      operatorNote: "Backfill only redacted watch results, artifact paths, receipt IDs, incident summaries, and owner handoff notes."
    });
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.followUpWatchReceiptQueue,
      [
        {
          key: "launch_day_watch_summary",
          operation: "record_cutover_walkthrough",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        },
        {
          key: "launch_day_watch_summary",
          operation: "record_launch_day_readiness_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        }
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpWatchEvidenceAction, {
      key: "launch_day_watch_summary",
      status: "pending_operator_entry",
      currentActionKey: "record_launch_day_watch_summary",
      currentCommand: null,
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
      receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
      receiptQueue: [
        {
          key: "launch_day_watch_summary",
          operation: "record_cutover_walkthrough",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        },
        {
          key: "launch_day_watch_summary",
          operation: "record_launch_day_readiness_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
        }
      ],
      expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions.",
      nextAction: "Record launch_day_watch_summary, attach receipt IDs, then continue launch-day watch evidence before stabilization handoff."
    });
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpStabilizationTarget, {
      key: "stabilization_owner_handoff",
      status: "pending_operator_entry",
      path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      receiptOperations: ["record_launch_stabilization_review"]
    });
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.followUpStabilizationSourceQueue,
      [
        {
          key: "launch_day_watch_summary",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
          receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
          expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."
        },
        {
          key: "first_wave_incident_log",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md",
          receiptOperations: ["record_post_launch_ops_sweep"],
          expectedEvidence: "Record first-wave incidents, customer impact, mitigation, owner, and status."
        },
        {
          key: "receipt_visibility_snapshot",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt",
          receiptOperations: ["record_post_launch_ops_sweep"],
          expectedEvidence: "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."
        },
        {
          key: "rollback_signal_review",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md",
          receiptOperations: ["record_rollback_walkthrough", "record_launch_stabilization_review"],
          expectedEvidence: "Record whether rollback signals were observed, dismissed, or escalated."
        },
        {
          key: "stabilization_owner_handoff",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
          receiptOperations: ["record_launch_stabilization_review"],
          expectedEvidence: "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."
        }
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpFirstWaveCloseoutTarget, {
      key: "first_wave_closeout",
      status: "operator_closeout",
      path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
    });
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpFirstWaveReceiptQueue, [
      {
        key: "first_wave_closeout",
        operation: "record_launch_closeout_review",
        status: "pending_operator_receipt",
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
      }
    ]);
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.followUpFirstWaveCloseoutAction, {
      key: "first_wave_closeout",
      status: "awaiting_first_wave_closeout",
      currentActionKey: "close_first_wave",
      currentCommand: null,
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      sourceRecordQueue: [
        {
          key: "first_wave_incident_log",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"
        },
        {
          key: "rollback_signal_review",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"
        },
        {
          key: "stabilization_owner_handoff",
          status: "pending_operator_entry",
          path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"
        }
      ],
      receiptQueue: [
        {
          key: "first_wave_closeout",
          operation: "record_launch_closeout_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
        }
      ],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
      nextAction: "Record first-wave closeout decision, unresolved incidents, customer impact, next-duty owner, and receipt ID."
    });
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.stabilizationHandoffNextAction,
      "Record stabilization owner handoff, then close first-wave stabilization."
    );
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.firstWaveCloseoutNextAction,
      "Record first-wave closeout decision, unresolved incidents, customer impact, next-duty owner, and receipt ID."
    );
    assert.equal(
      output.operatorExecutionPlan.launchDutyCurrentAction.watchEvidenceNextAction,
      "Record launch_day_watch_summary, attach receipt IDs, then continue launch-day watch evidence before stabilization handoff."
    );
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.confirmationPoints.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "pending_operator_entry"],
        ["stabilization_owner_handoff", "operator_handoff"]
      ]
    );
    assert.deepEqual(output.operatorExecutionPlan.launchDutyCurrentAction.archiveTrace, {
      archiveRoot: "artifacts/staging/PILOT_ALPHA/stable",
      runRecordIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-run-record-index.json",
      launchDutyArchiveIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json",
      currentPacketPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      currentRecordGroupKey: "launch_day_watch_and_stabilization",
      currentRecordGroupStatus: "ready_for_launch_day_watch",
      runRecordIndexStatus: "ready_for_launch_day_watch",
      launchDutyArchiveStatus: "awaiting_archive_review"
    });
    assert.deepEqual(
      output.operatorExecutionPlan.launchDutyCurrentAction.recordUpdates.map((item) => [item.key, item.groupKey, item.status, item.path]),
      [
        ["production_signoff_packet", "launch_day_watch_and_stabilization", "archive_before_cutover", "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"],
        ["launch_day_watch_summary", "launch_day_watch_and_stabilization", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["stabilization_owner_handoff", "launch_day_watch_and_stabilization", "operator_handoff", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry.watchEvidenceExecutionEntry.currentEvidenceKey,
      "launch_day_watch_summary"
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry.watchEvidenceExecutionEntry.nextAction,
      "Record launch_day_watch_summary, attach receipt IDs, then continue launch-day watch evidence before stabilization handoff."
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry.stabilizationHandoffExecutionEntry.currentActionKey,
      "handoff_stabilization_owner"
    );
    assert.equal(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry.firstWaveCloseoutExecutionEntry.currentActionKey,
      "close_first_wave"
    );
    assert.deepEqual(
      output.operatorExecutionPlan.goLiveExecutionEntry.launchDayWatchEntry.watchEvidenceExecutionEntry.receiptQueue,
      output.operatorExecutionPlan.launchDutyCurrentAction.followUpWatchReceiptQueue
    );
    assert.deepEqual(output.operatorExecutionPlan.fullTestSignoffFocus.missingSignoffKeys, []);
    assert.deepEqual(output.operatorExecutionPlan.fullTestSignoffFocus.missingReceiptVisibilityKeys, []);
    assert.equal(
      output.operatorExecutionPlan.launchDutyPacketFocus.nextAction,
      "Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff."
    );
    assert.equal(output.stagingLaunchDutyArchiveIndex.sourceStatuses.launchDayWatch, "ready");
    assert.equal(output.stagingLaunchDutyArchiveIndex.sourceStatuses.stabilizationHandoff, "ready");
    assert.equal(
      output.stagingLaunchDutyArchiveIndex.nextAction,
      "Archive production sign-off packet, record launch-day watch artifacts, and hand off stabilization owner records."
    );
    assert.equal(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.mode, "launch-duty-archive-review-execution-entry");
    assert.equal(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.status, "ready_for_launch_watch_archive_review");
    assert.equal(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.currentPhase, "launch_watch_and_stabilization");
    assert.equal(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.currentActionKey, "archive_production_signoff");
    assert.deepEqual(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.currentPacket, {
      key: "launch_duty_archive_index",
      status: "awaiting_archive_review",
      path: "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json"
    });
    assert.deepEqual(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.currentTarget, {
      key: "production_signoff_packet",
      status: "archive_before_cutover",
      path: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json"
    });
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.postSignoffQueue.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "record_during_cutover_watch"],
        ["receipt_visibility_snapshot", "record_during_cutover_watch"],
        ["first_wave_incident_log", "record_during_cutover_watch"],
        ["rollback_signal_review", "record_during_cutover_watch"],
        ["launch_duty_archive_index", "archive_with_signoff"],
        ["stabilization_owner_handoff", "prepare_after_cutover_watch"],
        ["first_wave_closeout", "close_after_stabilization_handoff"]
      ]
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.watchArtifactQueue.map((item) => [item.key, item.status]),
      [
        ["launch_day_watch_summary", "pending_operator_entry"],
        ["receipt_visibility_snapshot", "pending_operator_entry"],
        ["first_wave_incident_log", "pending_operator_entry"],
        ["rollback_signal_review", "pending_operator_entry"],
        ["stabilization_owner_handoff", "pending_operator_entry"]
      ]
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.stabilizationWindowQueue.map((item) => [item.key, item.status]),
      [
        ["stabilization_owner_handoff", "operator_handoff"],
        ["first_wave_closeout", "operator_closeout"]
      ]
    );
    assert.deepEqual(output.stagingLaunchDutyArchiveIndex.archiveReviewExecutionEntry.firstWaveCloseout, {
      status: "awaiting_first_wave_closeout",
      currentActionKey: "close_first_wave"
    });
    assert.match(handoff, /## Staging Launch Duty Archive Index[\s\S]*Archive review execution entry: ready_for_launch_watch_archive_review \(action=archive_production_signoff, target=production_signoff_packet\)[\s\S]*Archive review post-signoff queue: production_signoff_packet:archive_before_cutover, launch_day_watch_summary:record_during_cutover_watch[\s\S]*Archive review watch queue: launch_day_watch_summary:pending_operator_entry, receipt_visibility_snapshot:pending_operator_entry[\s\S]*Archive review stabilization queue: stabilization_owner_handoff:operator_handoff, first_wave_closeout:operator_closeout/);
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.watchArtifacts.map((item) => [item.key, item.status]),
      [
        ["launch_day_watch_summary", "pending_operator_entry"],
        ["receipt_visibility_snapshot", "pending_operator_entry"],
        ["first_wave_incident_log", "pending_operator_entry"],
        ["rollback_signal_review", "pending_operator_entry"],
        ["stabilization_owner_handoff", "pending_operator_entry"]
      ]
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.watchEvidenceCaptureEntries,
      output.launchDayWatchPlan.watchEvidenceCaptureEntries
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.stabilizationHandoff.handoffWindows.map((item) => [item.key, item.status]),
      [
        ["stabilization_owner_handoff", "operator_handoff"],
        ["first_wave_closeout", "operator_closeout"]
      ]
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.stabilizationHandoff.handoffWindows.map((item) => [item.key, item.receiptOperations, item.expectedEvidence]),
      [
        ["stabilization_owner_handoff", ["record_launch_stabilization_review"], "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
        ["first_wave_closeout", ["record_launch_closeout_review"], "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
      ]
    );
    assert.deepEqual(output.stabilizationHandoffPlan.firstWaveCloseoutGate, {
      status: "ready_for_first_wave_closeout",
      currentHandoffTargetKey: "stabilization_owner_handoff",
      ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
      firstWaveCloseoutPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
      requiredSourceRecordKeys: [
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ],
      sourceRecords: [
        ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ],
      receiptOperations: ["record_launch_closeout_review"],
      expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
      nextAction: "Record stabilization owner handoff, then close first-wave stabilization with incident, rollback, and next-duty evidence."
    });
    assert.deepEqual(output.stabilizationHandoffPlan.firstWaveCloseoutCaptureEntry, {
      mode: "first-wave-closeout-capture-entry",
      key: "first_wave_closeout",
      category: "stabilization_closeout",
      status: "operator_closeout",
      willModifyData: false,
      currentActionKey: "close_first_wave",
      currentCommand: null,
      resultBackfillTarget: {
        key: "first_wave_closeout",
        status: "operator_closeout",
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
        ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
        requiredSourceRecordKeys: [
          "first_wave_incident_log",
          "rollback_signal_review",
          "stabilization_owner_handoff"
        ],
        sourceRecords: [
          ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
          ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
          ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
        ],
        receiptOperations: ["record_launch_closeout_review"],
        expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
      },
      receiptTargets: [
        {
          operation: "record_launch_closeout_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
        }
      ],
      nextAction: "Record first-wave closeout decision, unresolved incidents, customer impact, next-duty owner, and receipt ID."
    });
    assert.deepEqual(output.stabilizationHandoffPlan.firstWaveCloseoutExecutionEntry, {
      mode: "first-wave-closeout-execution-entry",
      status: "awaiting_first_wave_closeout",
      willModifyData: false,
      currentActionKey: "close_first_wave",
      currentCommand: null,
      closeoutTarget: {
        key: "first_wave_closeout",
        status: "operator_closeout",
        path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
        ownerHandoffPath: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md",
        requiredSourceRecordKeys: [
          "first_wave_incident_log",
          "rollback_signal_review",
          "stabilization_owner_handoff"
        ],
        expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."
      },
      sourceRecordQueue: [
        { key: "first_wave_incident_log", status: "pending_operator_entry", path: "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md" },
        { key: "rollback_signal_review", status: "pending_operator_entry", path: "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md" },
        { key: "stabilization_owner_handoff", status: "pending_operator_entry", path: "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md" }
      ],
      receiptQueue: [
        {
          key: "first_wave_closeout",
          operation: "record_launch_closeout_review",
          status: "pending_operator_receipt",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
        }
      ],
      nextAction: "Record first-wave closeout decision, unresolved incidents, customer impact, next-duty owner, and receipt ID."
    });
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.stabilizationHandoff.firstWaveCloseoutGate,
      output.stabilizationHandoffPlan.firstWaveCloseoutGate
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.stabilizationHandoff.firstWaveCloseoutCaptureEntry,
      output.stabilizationHandoffPlan.firstWaveCloseoutCaptureEntry
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.stabilizationHandoff.firstWaveCloseoutExecutionEntry,
      output.stabilizationHandoffPlan.firstWaveCloseoutExecutionEntry
    );
    assert.equal(output.stabilizationHandoffPlan.currentHandoffTarget.key, "stabilization_owner_handoff");
    assert.equal(output.stabilizationHandoffPlan.currentHandoffTarget.status, "operator_handoff");
    assert.equal(output.stabilizationHandoffPlan.currentHandoffTarget.path, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md");
    assert.deepEqual(
      output.stabilizationHandoffPlan.sourceWatchRecords.map((item) => [item.key, item.status, item.path]),
      [
        ["launch_day_watch_summary", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
        ["first_wave_incident_log", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
        ["receipt_visibility_snapshot", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
        ["rollback_signal_review", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
        ["stabilization_owner_handoff", "pending_operator_entry", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
      ]
    );
    assert.deepEqual(
      output.stabilizationHandoffPlan.operatorSteps.map((item) => [item.key, item.status]),
      [
        ["verify_cutover_watch_records", "operator_review"],
        ["handoff_stabilization_owner", "operator_handoff"],
        ["close_first_wave", "operator_closeout"]
      ]
    );
    assert.equal(output.stabilizationHandoffPlan.operatorSteps[1].artifactPath, "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md");
    assert.equal(output.stabilizationHandoffPlan.operatorSteps[2].artifactPath, "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md");
    assert.match(
      handoff,
      /First-wave closeout gate: ready_for_first_wave_closeout \(owner=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md, closeout=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md\)/
    );
    assert.match(
      handoff,
      /Archive first-wave closeout gate: ready_for_first_wave_closeout \(owner=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md, closeout=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md\)/
    );
    assert.match(
      handoff,
      /First-wave closeout capture entry: operator_closeout \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*First-wave closeout capture receipts: record_launch_closeout_review:pending_operator_receipt[\s\S]*First-wave closeout capture sources: first_wave_incident_log=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/
    );
    assert.match(
      handoff,
      /First-wave closeout execution entry: awaiting_first_wave_closeout \(action=close_first_wave, target=first_wave_closeout\)[\s\S]*First-wave closeout execution sources: first_wave_incident_log=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=pending_operator_entry -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md[\s\S]*First-wave closeout execution receipts: first_wave_closeout=record_launch_closeout_review:pending_operator_receipt/
    );
    assert.match(
      handoff,
      /Archive first-wave closeout capture entry: operator_closeout \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md[\s\S]*Archive first-wave closeout capture receipts: record_launch_closeout_review:pending_operator_receipt/
    );
    assert.match(
      handoff,
      /Archive first-wave closeout execution entry: awaiting_first_wave_closeout \(action=close_first_wave, target=first_wave_closeout\)[\s\S]*Archive first-wave closeout execution receipts: first_wave_closeout=record_launch_closeout_review:pending_operator_receipt/
    );
    assert.match(
      handoff,
      /## Launch Day Watch Plan[\s\S]*Launch-day watch evidence capture entries: 5[\s\S]*launch_day_watch_summary: pending_operator_entry \(launch_day_watch_record, action=record_launch_day_watch_summary\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md[\s\S]*stabilization_owner_handoff: pending_operator_entry \(launch_day_watch_record, action=handoff_stabilization_owner\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/
    );
    assert.match(
      handoff,
      /## Stabilization Handoff Plan[\s\S]*Launch-day watch evidence capture entries: 5[\s\S]*rollback_signal_review: pending_operator_entry \(launch_day_watch_record, action=record_rollback_signal_review\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md/
    );
    assert.match(
      handoff,
      /## Staging Launch Duty Archive Index[\s\S]*Archive watch evidence capture entries: 5[\s\S]*receipt_visibility_snapshot: pending_operator_entry \(launch_day_watch_record, action=record_receipt_visibility_snapshot\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt/
    );
    assert.deepEqual(
      output.stagingLaunchDutyArchiveIndex.signoffTargets.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "record_during_cutover_watch"],
        ["receipt_visibility_snapshot", "record_during_cutover_watch"],
        ["first_wave_incident_log", "record_during_cutover_watch"],
        ["rollback_signal_review", "record_during_cutover_watch"],
        ["launch_duty_archive_index", "archive_with_signoff"],
        ["stabilization_owner_handoff", "prepare_after_cutover_watch"],
        ["first_wave_closeout", "close_after_stabilization_handoff"]
      ]
    );
    assert.equal(output.finalRehearsalPacket.status, "ready_for_launch_day_watch");
    assert.equal(output.finalRehearsalPacket.readinessTransitionStatus, "ready_for_launch_day_watch");
    assert.deepEqual(output.finalRehearsalPacket.sourceReadiness, {
      fullTestWindow: "ready",
      productionSignoff: "ready",
      launchDayWatch: "ready",
      stabilizationHandoff: "ready"
    });
    assert.deepEqual(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyFocus, {
      status: "ready_for_cutover_watch",
      postSignoffActionCount: 8,
      blockedPostSignoffActionCount: 0,
      readyPostSignoffActionCount: 8,
      watchArtifactCount: 5,
      pendingWatchArtifactCount: 5,
      blockedWatchArtifactCount: 0,
      firstPostSignoffAction: "production_signoff_packet",
      nextAction: "Archive production_signoff_packet, then record launch-day watch artifacts and prepare stabilization handoff."
    });
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.stage, "launch_day_watch_entry");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.key, "archive_production_signoff");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.evidenceInputs.length, 3);
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.followUpWatchRecord.key, "launch_day_watch_summary");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.followUpFirstWaveCloseoutTarget.key, "first_wave_closeout");
    assert.equal(output.stagingRehearsalExecutionSummary.operatorFocus.launchDutyCurrentAction.archiveTrace.currentRecordGroupKey, "launch_day_watch_and_stabilization");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.mode, "launch-duty-current-action");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.stage, "launch_day_watch_entry");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.key, "archive_production_signoff");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.followUpWatchRecord.key, "launch_day_watch_summary");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.followUpWatchEvidenceAction.currentActionKey, "record_launch_day_watch_summary");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.followUpFirstWaveCloseoutTarget.key, "first_wave_closeout");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.followUpFirstWaveCloseoutAction.currentActionKey, "close_first_wave");
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.confirmationPoints.length, 3);
    assert.equal(output.finalRehearsalPacket.launchDutyCurrentAction.recordUpdates.length, 3);
    assert.deepEqual(output.stagingRehearsalExecutionSummary.operatorFocus.launchReadinessClosure, {
      status: "ready_for_launch_day_watch",
      remainingBlockerCount: 0,
      remainingBlockers: [],
      nextPlan: [
        {
          key: "start_launch_day_watch",
          status: "operator_watch",
          nextAction: "Open Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status during cutover."
        },
        {
          key: "record_watch_artifacts",
          status: "operator_record",
          nextAction: "Record launch-day watch summary, receipt visibility snapshot, incident log, and rollback signal review."
        },
        {
          key: "prepare_stabilization_handoff",
          status: "operator_handoff",
          nextAction: "Hand off stabilization owner records and first-wave closeout evidence."
        }
      ],
      nextAction: "Start launch-day watch and stabilization handoff from the final rehearsal packet."
    });
    assert.deepEqual(
      output.finalRehearsalPacket.postSignoffActionChecklist.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "record_during_cutover_watch"],
        ["receipt_visibility_snapshot", "record_during_cutover_watch"],
        ["first_wave_incident_log", "record_during_cutover_watch"],
        ["rollback_signal_review", "record_during_cutover_watch"],
        ["launch_duty_archive_index", "archive_with_signoff"],
        ["stabilization_owner_handoff", "prepare_after_cutover_watch"],
        ["first_wave_closeout", "close_after_stabilization_handoff"]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.postSignoffActionChecklist.map((item) => [item.key, item.status]),
      [
        ["production_signoff_packet", "archive_before_cutover"],
        ["launch_day_watch_summary", "record_during_cutover_watch"],
        ["receipt_visibility_snapshot", "record_during_cutover_watch"],
        ["first_wave_incident_log", "record_during_cutover_watch"],
        ["rollback_signal_review", "record_during_cutover_watch"],
        ["launch_duty_archive_index", "archive_with_signoff"],
        ["stabilization_owner_handoff", "prepare_after_cutover_watch"],
        ["first_wave_closeout", "close_after_stabilization_handoff"]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.postSignoffActionChecklist.map((item) => [item.key, item.receiptOperations, item.expectedEvidence]),
      [
        ["production_signoff_packet", [], "Archive the signed production sign-off packet with full-test status, GO/NO-GO decision, and receipt visibility lanes."],
        ["launch_day_watch_summary", ["record_cutover_walkthrough", "record_launch_day_readiness_review"], "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions."],
        ["receipt_visibility_snapshot", ["record_post_launch_ops_sweep"], "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots."],
        ["first_wave_incident_log", ["record_post_launch_ops_sweep"], "Record first-wave incidents, customer impact, mitigation, owner, and status."],
        ["rollback_signal_review", ["record_rollback_walkthrough", "record_launch_stabilization_review"], "Record whether rollback signals were observed, dismissed, or escalated."],
        ["launch_duty_archive_index", [], "Keep the launch-duty archive index with packet paths, record groups, and current next action."],
        ["stabilization_owner_handoff", ["record_launch_stabilization_review"], "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."],
        ["first_wave_closeout", ["record_launch_closeout_review"], "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp."]
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.postSignoffActionChecklist.map((item) => [item.key, item.currentActionKey]),
      [
        ["production_signoff_packet", "archive_production_signoff"],
        ["launch_day_watch_summary", "record_launch_day_watch_summary"],
        ["receipt_visibility_snapshot", "record_receipt_visibility_snapshot"],
        ["first_wave_incident_log", "record_first_wave_incident_log"],
        ["rollback_signal_review", "record_rollback_signal_review"],
        ["launch_duty_archive_index", "review_launch_duty_archive_index"],
        ["stabilization_owner_handoff", "handoff_stabilization_owner"],
        ["first_wave_closeout", "close_first_wave"]
      ]
    );
    assert.match(handoff, /Post-signoff action checklist:[\s\S]*first_wave_closeout: close_after_stabilization_handoff \(action=close_first_wave\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(handoff, /Post-signoff targets:[\s\S]*rollback_signal_review: record_during_cutover_watch \(action=record_rollback_signal_review\) -> artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md/);
    assert.equal(output.stagingRehearsalRunRecordIndex.status, "ready_for_launch_day_watch");
    assert.deepEqual(output.stagingRehearsalRunRecordIndex.signoffProgress.missingSignoffKeys, []);
    assert.deepEqual(output.stagingRehearsalRunRecordIndex.signoffProgress.missingReceiptVisibilityKeys, []);
    assert.deepEqual(
      output.stagingRehearsalRunRecordIndex.recordGroups.map((item) => [item.key, item.status]),
      [
        ["pre_full_test_closeout", "ready_for_full_test_window"],
        ["production_signoff", "ready_for_production_signoff"],
        ["launch_day_watch_and_stabilization", "ready_for_launch_day_watch"]
      ]
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.gapCount, 1);
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

test("staging rehearsal runner blocks production signoff until all receipt visibility lanes and overview status are visible", () => {
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
    const signoffConditions = expectedProductionSignoffConditionKeys.map((key) => ({
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
        developerOps: "visible"
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
    assert.deepEqual(output.closeoutInput.missingReceiptVisibilityKeys, ["launchOpsOverviewStatus"]);
    assert.deepEqual(output.productionSignoffReadiness.signoffEvidenceTargets, expectedSignoffEvidenceTargets([]));
    assert.deepEqual(output.productionSignoffReadiness.receiptVisibilityEvidenceTargets, expectedReceiptVisibilityEvidenceTargets(["launchOpsOverviewStatus"]));
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
      ["launchOpsOverviewStatus"]
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.readinessSummary.canSignoffProduction, false);
    assert.equal(output.productionSignoffReadiness.status, "blocked");
    assert.equal(output.productionSignoffReadiness.canSignoff, false);
    assert.deepEqual(output.productionSignoffReadiness.missingReceiptVisibilityKeys, ["launchOpsOverviewStatus"]);
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
