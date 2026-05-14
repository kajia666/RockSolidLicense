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
    const postRouteMapReadinessStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const smokePreflightCommand = "npm.cmd run staging:preflight -- --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta";
    const launchSmokeStagingCommand = "npm.cmd run launch:smoke:staging -- --base-url https://staging.example.com --allow-live-writes --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
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
        handoffFile: "artifacts/staging/PILOT_ALPHA/beta/staging-rehearsal-handoff.md",
        launchDutyArchiveIndexFile: "artifacts/staging/PILOT_ALPHA/beta/staging-launch-duty-archive-index.json",
        launchDutyRecordIndexFile: "artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json",
        nextAction: "Use these paths for the first real staging rehearsal, closeout init, readiness refresh, backup/restore evidence, route-map gate handoff, and launch smoke closeout backfills."
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
        }
      ],
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, and post-smoke closeout backfills."
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
    assert.match(result.stdout, /Launch lane record index: artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json/);
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
    assert.match(result.stdout, /Next action: Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, and post-smoke closeout backfills\./);
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
