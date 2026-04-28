import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
