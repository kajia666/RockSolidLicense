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
    assert.doesNotMatch(handoff, /StrongAdmin123!|StrongDeveloper123!/);
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
  assert.doesNotMatch(result.stdout, /developer-secret-token/);
});
