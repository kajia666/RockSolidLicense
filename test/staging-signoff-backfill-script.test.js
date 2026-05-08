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
    assert.deepEqual(JSON.parse(signoffResult.stdout), {
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "production_signoff_condition",
      key: "full_test_window_passed",
      productionDecision: "ready-for-production-signoff",
      filledConditionCount: 1,
      visibleReceiptLaneCount: 0,
      missingConditionCount: 6,
      missingReceiptLaneCount: 5,
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
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
    assert.deepEqual(JSON.parse(receiptResult.stdout), {
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "receipt_visibility_lane",
      key: "launchMainline",
      productionDecision: "ready-for-production-signoff",
      filledConditionCount: 1,
      visibleReceiptLaneCount: 1,
      missingConditionCount: 6,
      missingReceiptLaneCount: 4,
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
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
