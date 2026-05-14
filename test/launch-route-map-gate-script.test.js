import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

test("launch route map gate is exposed as a reusable targeted verification script", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["launch:route-map-gate"], "node scripts/launch-route-map-gate.mjs");

  const result = spawnSync(process.execPath, ["scripts/launch-route-map-gate.mjs", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "launch-route-map-gate");
  assert.equal(output.dryRun, true);
  assert.equal(output.summary.willRunFullSuite, false);
  assert.match(output.summary.scope, /first-batch runtime evidence/i);
  assert.equal(output.closeoutBackfill.status, "ready_for_route_map_gate_backfill");
  assert.equal(output.closeoutBackfill.key, "route_map_gate_result");
  assert.equal(output.closeoutBackfill.filledCloseoutInputFile, "artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json");
  assert.equal(output.closeoutBackfill.readinessActionQueueFile, "artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md");
  assert.equal(output.closeoutBackfill.artifactPath, "artifacts/staging/ROUTE_MAP_GATE/stable/route-map-gate-output.txt");
  assert.equal(
    output.closeoutBackfill.command,
    "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/route-map-gate-output.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.closeoutBackfill.statusCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.equal(output.launchSwitchWatchHandoff.status, "ready_for_staging_readiness_and_launch_smoke_switch");
  assert.equal(output.launchSwitchWatchHandoff.currentActionKey, "refresh_staging_readiness");
  assert.equal(
    output.launchSwitchWatchHandoff.currentCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.equal(output.launchSwitchWatchHandoff.nextActionKey, "run_launch_smoke_staging");
  assert.equal(
    output.launchSwitchWatchHandoff.launchSmokeCommand,
    "npm.cmd run launch:smoke:staging -- --base-url https://staging.example.com --allow-live-writes --product-code ROUTE_MAP_GATE --channel stable --closeout-input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.backfillSequence.map((item) => [item.order, item.key, item.status]),
    [
      [1, "route_map_gate_result", "current"],
      [2, "live_write_smoke_result", "blocked_until_launch_smoke"],
      [3, "launch_smoke_handoff", "blocked_until_launch_smoke"],
      [4, "launch_mainline_evidence_receipts", "blocked_until_launch_smoke"],
      [5, "receipt_visibility_review", "blocked_until_receipt_visibility_review"]
    ]
  );
  assert.deepEqual(output.launchSwitchWatchHandoff.credentialEnv, [
    "RSL_SMOKE_DEVELOPER_USERNAME",
    "RSL_SMOKE_DEVELOPER_PASSWORD"
  ]);
  assert.deepEqual(output.launchSwitchWatchHandoff.smokePrerequisites, {
    status: "ready_for_staging_launch_smoke_command",
    stagingBaseUrl: "https://staging.example.com",
    requireHttps: true,
    allowLiveWrites: true,
    credentialEnv: [
      "RSL_SMOKE_DEVELOPER_USERNAME",
      "RSL_SMOKE_DEVELOPER_PASSWORD"
    ],
    filledCloseoutInputFile: "artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json",
    readinessActionQueueFile: "artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md",
    nextAction: "Set smoke credential env vars, confirm the HTTPS staging base URL, then run launchSmokeCommand."
  });
  assert.equal(output.launchSwitchWatchHandoff.postSmokeCloseoutChecks.status, "ready_for_post_smoke_closeout_confirmation");
  assert.equal(
    output.launchSwitchWatchHandoff.postSmokeCloseoutChecks.statusCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.postSmokeCloseoutChecks.evidenceChecks.map((item) => [item.order, item.key, item.status, item.artifactPath]),
    [
      [1, "live_write_smoke_result", "expected_after_launch_smoke", "artifacts/staging/ROUTE_MAP_GATE/stable/live-write-smoke-output.json"],
      [2, "launch_smoke_handoff", "expected_after_launch_smoke", "artifacts/staging/ROUTE_MAP_GATE/stable/launch-smoke-handoff.json"],
      [3, "launch_mainline_evidence_receipts", "expected_after_launch_smoke", "artifacts/staging/ROUTE_MAP_GATE/stable/launch-mainline-evidence-receipts.json"],
      [4, "receipt_visibility_review", "expected_after_receipt_visibility_review", "artifacts/staging/ROUTE_MAP_GATE/stable/receipt-visibility-review.txt"]
    ]
  );
  assert.equal(
    output.launchSwitchWatchHandoff.postSmokeCloseoutChecks.evidenceChecks[3].receiptVisibilityQueue[0].target,
    output.launchSmokeReceiptVisibilityQueue[0].target
  );
  assert.equal(output.launchSwitchWatchHandoff.postSmokeReadinessGate.status, "ready_for_readiness_gate_after_post_smoke");
  assert.equal(
    output.launchSwitchWatchHandoff.postSmokeReadinessGate.statusCommand,
    output.launchSwitchWatchHandoff.postSmokeCloseoutChecks.statusCommand
  );
  assert.equal(output.launchSwitchWatchHandoff.postSmokeReadinessGate.fullTestCommand, "npm.cmd test");
  assert.equal(
    output.launchSwitchWatchHandoff.postSmokeReadinessGate.fullTestResultArtifactPath,
    "artifacts/staging/ROUTE_MAP_GATE/stable/full-test-output.txt"
  );
  assert.equal(
    output.launchSwitchWatchHandoff.postSmokeReadinessGate.signoffBackfillCommand,
    "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.postSmokeReadinessGate.expectedGateProgression.map((item) => [item.order, item.gate, item.status, item.command]),
    [
      [1, "full_test_window", "current_after_post_smoke_closeout_confirmed", "npm.cmd test"],
      [
        2,
        "production_signoff",
        "blocked_after_full_test_window",
        "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
      ],
      [
        3,
        "launch_day_watch",
        "blocked_after_production_signoff",
        "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
      ]
    ]
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.status,
    "ready_for_launch_day_watch_after_production_signoff"
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.productionSignoffPacketPath,
    "artifacts/staging/ROUTE_MAP_GATE/stable/staging-production-signoff-packet.json"
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.archiveIndexPath,
    "artifacts/staging/ROUTE_MAP_GATE/stable/staging-launch-duty-archive-index.json"
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.recordCommands.map((item) => [item.order, item.key, item.status, item.artifactPath]),
    [
      [1, "launch_day_watch_summary", "current_after_production_signoff", "artifacts/staging/ROUTE_MAP_GATE/stable/launch-day-watch-summary.md"],
      [2, "first_wave_closeout", "blocked_after_launch_day_watch_summary", "artifacts/staging/ROUTE_MAP_GATE/stable/first-wave-closeout.md"]
    ]
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.recordCommands[0].command,
    "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --key launch_day_watch_summary --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/launch-day-watch-summary.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts/staging/ROUTE_MAP_GATE/stable/launch-duty-record-index.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.recordCommands[1].sourceRecordKeys,
    ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
  );
  assert.deepEqual(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueue.map((item) => [item.order, item.key, item.status, item.artifactPath]),
    [
      [1, "receipt_visibility_snapshot", "blocked_after_launch_day_watch_summary", "artifacts/staging/ROUTE_MAP_GATE/stable/receipt-visibility-snapshot.txt"],
      [2, "first_wave_incident_log", "blocked_after_receipt_visibility_snapshot", "artifacts/staging/ROUTE_MAP_GATE/stable/first-wave-incident-log.md"],
      [3, "rollback_signal_review", "blocked_after_first_wave_incident_log", "artifacts/staging/ROUTE_MAP_GATE/stable/rollback-signal-review.md"],
      [4, "stabilization_owner_handoff", "blocked_after_rollback_signal_review", "artifacts/staging/ROUTE_MAP_GATE/stable/stabilization-owner-handoff.md"],
      [5, "first_wave_closeout", "blocked_until_source_records", "artifacts/staging/ROUTE_MAP_GATE/stable/first-wave-closeout.md"]
    ]
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueue[0].command,
    "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --key receipt_visibility_snapshot --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/receipt-visibility-snapshot.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file artifacts/staging/ROUTE_MAP_GATE/stable/launch-duty-record-index.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueue[4].command,
    "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/ROUTE_MAP_GATE/stable/filled-closeout-input.json --key first_wave_closeout --artifact-path artifacts/staging/ROUTE_MAP_GATE/stable/first-wave-closeout.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=artifacts/staging/ROUTE_MAP_GATE/stable/first-wave-incident-log.md --source-record rollback_signal_review=artifacts/staging/ROUTE_MAP_GATE/stable/rollback-signal-review.md --source-record stabilization_owner_handoff=artifacts/staging/ROUTE_MAP_GATE/stable/stabilization-owner-handoff.md --record-index-file artifacts/staging/ROUTE_MAP_GATE/stable/launch-duty-record-index.json --actions-file artifacts/staging/ROUTE_MAP_GATE/stable/readiness-action-queue.md"
  );
  assert.equal(output.launchSwitchWatchHandoff.launchDutyRecordIndexPath, "artifacts/staging/ROUTE_MAP_GATE/stable/launch-duty-record-index.json");
  assert.deepEqual(
    output.launchSwitchWatchHandoff.operatorNextCommands.map((item) => [item.order, item.key, item.status, item.kind]),
    [
      [1, "backfill_route_map_gate_result", "current", "command"],
      [2, "refresh_staging_readiness_after_route_map", "blocked_after_route_map_backfill", "command"],
      [3, "run_launch_smoke_staging", "blocked_after_readiness_refresh", "command"],
      [4, "refresh_staging_readiness_after_launch_smoke", "blocked_after_launch_smoke", "command"],
      [5, "verify_receipt_visibility_queue", "blocked_after_launch_smoke", "download_queue"]
    ]
  );
  assert.equal(
    output.launchSwitchWatchHandoff.operatorNextCommands[0].command,
    output.closeoutBackfill.command
  );
  assert.equal(
    output.launchSwitchWatchHandoff.operatorNextCommands[2].command,
    output.launchSwitchWatchHandoff.launchSmokeCommand
  );
  assert.equal(
    output.launchSwitchWatchHandoff.operatorNextCommands[4].queue[0].target,
    output.launchSmokeReceiptVisibilityQueue[0].target
  );
  assert.deepEqual(
    output.launchSmokeReceiptVisibilityQueue.map((item) => [item.order, item.key, item.status, item.kind]),
    [
      [1, "verify_launch_review_receipt_visibility", "current", "download"],
      [2, "verify_launch_smoke_receipt_visibility", "next", "download"],
      [3, "verify_launch_ops_overview_status", "next", "download"],
      [4, "verify_mainline_route_map_overview_evidence", "next", "download"],
      [5, "download_ops_handoff_index", "next", "download"]
    ]
  );
  assert.equal(output.launchSmokeReceiptVisibilityQueue[0].target, "/api/developer/launch-review/download?productCode=ROUTE_MAP_GATE&channel=stable&source=launch-smoke&handoff=first-wave&format=summary");
  assert.equal(output.launchSmokeReceiptVisibilityQueue[0].launchDutyRecordIndexPath, "artifacts/staging/ROUTE_MAP_GATE/stable/launch-duty-record-index.json");
  assert.equal(output.launchSmokeReceiptVisibilityQueue[4].target, "/api/developer/ops/export/download?productCode=ROUTE_MAP_GATE&format=handoff-index&limit=20");
  assert.deepEqual(
    output.commands.map((command) => command.key),
    [
      "launch_mainline_action_visibility",
      "launch_route_map_gate_script",
      "recovery_preflight_script",
      "developer_ops_export_and_mainline_action",
      "launch_download_surface_audit",
      "launch_smoke_script",
      "staging_profile_init_script",
      "staging_closeout_init_script",
      "staging_closeout_backfill_script",
      "staging_signoff_backfill_script",
      "staging_readiness_status_script",
      "staging_launch_duty_record_script",
      "staging_rehearsal_syntax_check",
      "staging_rehearsal_script",
      "services_syntax_check",
      "diff_whitespace_check"
    ]
  );

  const routeMapGateScriptCommand = output.commands.find(
    (command) => command.key === "launch_route_map_gate_script"
  );
  assert.ok(routeMapGateScriptCommand);
  assert.equal(
    routeMapGateScriptCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/launch-route-map-gate-script.test.js"
  );

  const recoveryPreflightCommand = output.commands.find(
    (command) => command.key === "recovery_preflight_script"
  );
  assert.ok(recoveryPreflightCommand);
  assert.equal(
    recoveryPreflightCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/recovery-preflight-script.test.js"
  );

  const stagingProfileInitCommand = output.commands.find(
    (command) => command.key === "staging_profile_init_script"
  );
  assert.ok(stagingProfileInitCommand);
  assert.equal(
    stagingProfileInitCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js"
  );

  const stagingCloseoutInitCommand = output.commands.find(
    (command) => command.key === "staging_closeout_init_script"
  );
  assert.ok(stagingCloseoutInitCommand);
  assert.equal(
    stagingCloseoutInitCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-closeout-init-script.test.js"
  );

  const stagingCloseoutBackfillCommand = output.commands.find(
    (command) => command.key === "staging_closeout_backfill_script"
  );
  assert.ok(stagingCloseoutBackfillCommand);
  assert.equal(
    stagingCloseoutBackfillCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-closeout-backfill-script.test.js"
  );

  const stagingSignoffBackfillCommand = output.commands.find(
    (command) => command.key === "staging_signoff_backfill_script"
  );
  assert.ok(stagingSignoffBackfillCommand);
  assert.equal(
    stagingSignoffBackfillCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-signoff-backfill-script.test.js"
  );

  const stagingReadinessStatusCommand = output.commands.find(
    (command) => command.key === "staging_readiness_status_script"
  );
  assert.ok(stagingReadinessStatusCommand);
  assert.equal(
    stagingReadinessStatusCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-readiness-status-script.test.js"
  );

  const stagingLaunchDutyRecordCommand = output.commands.find(
    (command) => command.key === "staging_launch_duty_record_script"
  );
  assert.ok(stagingLaunchDutyRecordCommand);
  assert.equal(
    stagingLaunchDutyRecordCommand.commandLine,
    "node --test --test-concurrency=1 --test-isolation=none test/staging-launch-duty-record-script.test.js"
  );

  const stagingSyntaxCommand = output.commands.find(
    (command) => command.key === "staging_rehearsal_syntax_check"
  );
  assert.ok(stagingSyntaxCommand);
  assert.equal(stagingSyntaxCommand.commandLine, "node --check scripts/staging-rehearsal.mjs");

  const licenseFlowCommand = output.commands.find(
    (command) => command.key === "developer_ops_export_and_mainline_action"
  );
  assert.ok(licenseFlowCommand);
  assert.match(licenseFlowCommand.label, /first-batch runtime evidence/i);
  assert.ok(licenseFlowCommand.args.includes("--test-name-pattern"));
  assert.match(
    licenseFlowCommand.args[licenseFlowCommand.args.indexOf("--test-name-pattern") + 1],
    /developer ops export bundles scoped data and downloadable assets/
  );
  assert.match(
    licenseFlowCommand.args[licenseFlowCommand.args.indexOf("--test-name-pattern") + 1],
    /developer launch mainline action can record a first-wave ops sweep/
  );
  assert.match(
    licenseFlowCommand.args[licenseFlowCommand.args.indexOf("--test-name-pattern") + 1],
    /developer license quickstart first-batch setup can create recommended launch card batches/
  );

  const downloadAuditCommand = output.commands.find(
    (command) => command.key === "launch_download_surface_audit"
  );
  assert.ok(downloadAuditCommand);
  assert.ok(downloadAuditCommand.args.includes("--test-name-pattern"));
  const downloadPattern = downloadAuditCommand.args[downloadAuditCommand.args.indexOf("--test-name-pattern") + 1];
  assert.match(downloadPattern, /developer release package export bundles integration/);
  assert.match(downloadPattern, /developer first-wave recommendations summarize launch inventory/);
  assert.match(downloadPattern, /developer integration package export is scoped/);
  assert.match(downloadPattern, /developer operators can manage scoped authorization operations/);
  assert.match(downloadPattern, /admin ops export bundles platform snapshots/);
});

test("launch route map gate dry run prints the closeout backfill handoff", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/launch-route-map-gate.mjs", "--dry-run", "--product-code", "PILOT_ALPHA", "--channel", "stable"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Launch route-map targeted gate dry run:/);
  assert.match(result.stdout, /Route-map closeout backfill current: route_map_gate_result/);
  assert.match(result.stdout, /Route-map closeout backfill command: npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Route-map readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Launch switch watch handoff: ready_for_staging_readiness_and_launch_smoke_switch/);
  assert.match(result.stdout, /Launch switch current: refresh_staging_readiness -> npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Launch switch next: run_launch_smoke_staging -> npm\.cmd run launch:smoke:staging -- --base-url https:\/\/staging\.example\.com --allow-live-writes --product-code PILOT_ALPHA --channel stable --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Launch switch evidence sequence: route_map_gate_result -> live_write_smoke_result -> launch_smoke_handoff -> launch_mainline_evidence_receipts -> receipt_visibility_review/);
  assert.match(result.stdout, /Launch switch credential env: RSL_SMOKE_DEVELOPER_USERNAME, RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.match(result.stdout, /Launch switch smoke prerequisites: ready_for_staging_launch_smoke_command \| https=yes \| allowLiveWrites=yes \| baseUrl=https:\/\/staging\.example\.com/);
  assert.match(result.stdout, /Launch switch post-smoke checks: ready_for_post_smoke_closeout_confirmation \| statusCommand=npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Post-smoke check 1\. live_write_smoke_result: expected_after_launch_smoke -> artifacts\/staging\/PILOT_ALPHA\/stable\/live-write-smoke-output\.json/);
  assert.match(result.stdout, /Post-smoke check 4\. receipt_visibility_review: expected_after_receipt_visibility_review -> artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-review\.txt \| queue=5/);
  assert.match(result.stdout, /Launch switch readiness gate: ready_for_readiness_gate_after_post_smoke \| statusCommand=npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Readiness gate 1\. full_test_window: current_after_post_smoke_closeout_confirmed -> npm\.cmd test \| artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt/);
  assert.match(result.stdout, /Readiness gate 2\. production_signoff: blocked_after_full_test_window -> npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt --decision ready-for-production-signoff --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Readiness gate 3\. launch_day_watch: blocked_after_production_signoff -> npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Launch switch launch-day watch: ready_for_launch_day_watch_after_production_signoff \| packet=artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json \| recordIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
  assert.match(result.stdout, /Launch-day watch 1\. launch_day_watch_summary: current_after_production_signoff -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key launch_day_watch_summary --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Launch-day watch 2\. first_wave_closeout: blocked_after_launch_day_watch_summary -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key first_wave_closeout --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md \| sources=first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
  assert.match(result.stdout, /Launch switch stabilization record queue: ready_after_launch_day_watch_summary \| records=5 \| closeout=first_wave_closeout/);
  assert.match(result.stdout, /Stabilization record 1\. receipt_visibility_snapshot: blocked_after_launch_day_watch_summary -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key receipt_visibility_snapshot --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/receipt-visibility-snapshot\.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Stabilization record 5\. first_wave_closeout: blocked_until_source_records -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key first_wave_closeout --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md --source-record rollback_signal_review=artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md --source-record stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md --record-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md \| sources=first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
  assert.match(result.stdout, /Launch switch record index: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
  assert.match(result.stdout, /Launch switch operator queue:/);
  assert.match(result.stdout, /1\. backfill_route_map_gate_result: current command -> npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /3\. run_launch_smoke_staging: blocked_after_readiness_refresh command -> npm\.cmd run launch:smoke:staging -- --base-url https:\/\/staging\.example\.com --allow-live-writes --product-code PILOT_ALPHA --channel stable --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /5\. verify_receipt_visibility_queue: blocked_after_launch_smoke download_queue -> first=\/api\/developer\/launch-review\/download\?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary \| count=5/);
  assert.match(result.stdout, /Launch Smoke receipt visibility queue:/);
  assert.match(result.stdout, /1\. verify_launch_review_receipt_visibility: current download -> \/api\/developer\/launch-review\/download\?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary \| recordIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
  assert.match(result.stdout, /5\. download_ops_handoff_index: next download -> \/api\/developer\/ops\/export\/download\?productCode=PILOT_ALPHA&format=handoff-index&limit=20 \| recordIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
});

test("launch route map gate validates staging smoke base URL before printing handoff commands", () => {
  const customResult = spawnSync(
    process.execPath,
    [
      "scripts/launch-route-map-gate.mjs",
      "--dry-run",
      "--json",
      "--product-code",
      "PILOT_ALPHA",
      "--staging-base-url",
      "https://pilot-staging.example.com"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000
    }
  );

  assert.equal(customResult.status, 0, customResult.stderr || customResult.stdout);
  const customOutput = JSON.parse(customResult.stdout);
  assert.equal(customOutput.launchSwitchWatchHandoff.smokePrerequisites.stagingBaseUrl, "https://pilot-staging.example.com");
  assert.match(customOutput.launchSwitchWatchHandoff.launchSmokeCommand, /--base-url https:\/\/pilot-staging\.example\.com/);

  const unsafeResult = spawnSync(
    process.execPath,
    [
      "scripts/launch-route-map-gate.mjs",
      "--dry-run",
      "--json",
      "--staging-base-url",
      "http://staging.example.com"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000
    }
  );

  assert.equal(unsafeResult.status, 1);
  assert.equal(unsafeResult.stdout, "");
  assert.match(unsafeResult.stderr, /--staging-base-url must use https:\/\/ for launch:smoke:staging handoff/);
});
