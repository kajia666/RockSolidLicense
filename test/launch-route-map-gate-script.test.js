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
  assert.match(result.stdout, /Launch Smoke receipt visibility queue:/);
  assert.match(result.stdout, /1\. verify_launch_review_receipt_visibility: current download -> \/api\/developer\/launch-review\/download\?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary \| recordIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
  assert.match(result.stdout, /5\. download_ops_handoff_index: next download -> \/api\/developer\/ops\/export\/download\?productCode=PILOT_ALPHA&format=handoff-index&limit=20 \| recordIndex=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
});
