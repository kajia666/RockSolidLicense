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

function runStatus(args) {
  return spawnSync(process.execPath, ["scripts/staging-readiness-status.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function writeCloseoutInput(file, {
  filledCloseoutKeys = [],
  decision = null,
  productionDecision = null,
  filledSignoffKeys = [],
  visibleReceiptLanes = []
} = {}) {
  const payload = {
    mode: "staging-closeout-template",
    decision,
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: filledCloseoutKeys.includes(key) ? "filled" : "pending_operator_entry",
      value: filledCloseoutKeys.includes(key)
        ? key === "operator_go_no_go"
          ? "ready-for-full-test-window"
          : { result: "pass" }
        : null
    })),
    receiptVisibility: Object.fromEntries(
      visibleReceiptLanes.map((key) => [key, { status: "visible", artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${key}.json` }])
    ),
    productionSignoff: {
      decision: productionDecision,
      conditions: signoffKeys.map((key) => ({
        key,
        status: filledSignoffKeys.includes(key) ? "filled" : "pending_operator_entry",
        value: filledSignoffKeys.includes(key) ? { result: key === "full_test_window_passed" ? "pass" : "confirmed" } : null
      }))
    }
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("staging readiness status reports closeout gap and next backfill command", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:readiness:status"], "node scripts/staging-readiness-status.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-closeout-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: ["route_map_gate_result"]
    });

    const result = runStatus(["--input-file", inputFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.mode, "staging-readiness-status");
    assert.equal(output.inputFile, inputFile);
    assert.deepEqual(output.readiness.closeout.missingKeys, closeoutKeys.slice(1));
    assert.equal(output.readiness.currentGate, "pre_full_test_closeout");
    assert.equal(output.readiness.launchStatus, "blocked");
    assert.equal(output.readiness.canRunFullTestWindow, false);
    assert.equal(output.readiness.canSignoffProduction, false);
    assert.equal(output.nextStep.key, "backfill_closeout_evidence");
    assert.equal(output.nextStep.targetKey, "backup_restore_drill_result");
    assert.equal(
      output.nextStep.command,
      `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key backup_restore_drill_result --value-json <redacted-json>`
    );
    assert.equal(
      output.nextStep.reloadCommand,
      `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status points to full-test window after closeout is ready", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-full-test-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window"
    });

    const result = runStatus(["--input-file", inputFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.readiness.currentGate, "full_test_window");
    assert.equal(output.readiness.canRunFullTestWindow, true);
    assert.equal(output.readiness.canSignoffProduction, false);
    assert.equal(output.nextStep.key, "run_full_test_window");
    assert.equal(output.nextStep.command, "npm.cmd test");
    assert.equal(output.nextStep.targetKey, "full_test_window_passed");
    assert.equal(
      output.nextStep.backfillCommand,
      `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff`
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status reports signoff and receipt visibility gaps before launch watch", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-signoff-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: ["full_test_window_passed"],
      visibleReceiptLanes: ["launchMainline"]
    });

    const result = runStatus(["--input-file", inputFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.readiness.currentGate, "production_signoff");
    assert.equal(output.readiness.productionSignoff.filledConditionCount, 1);
    assert.deepEqual(output.readiness.productionSignoff.missingConditionKeys, signoffKeys.slice(1));
    assert.equal(output.readiness.productionSignoff.visibleReceiptLaneCount, 1);
    assert.deepEqual(output.readiness.productionSignoff.missingReceiptVisibilityKeys, receiptVisibilityKeys.slice(1));
    assert.equal(output.nextStep.key, "backfill_production_signoff");
    assert.equal(output.nextStep.targetKey, "staging_artifacts_archived");
    assert.equal(
      output.nextStep.command,
      `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key staging_artifacts_archived --value-json <redacted-json>`
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status reports launch-day watch readiness after all local gates are clear", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-ready-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: signoffKeys,
      visibleReceiptLanes: receiptVisibilityKeys
    });

    const result = runStatus(["--input-file", inputFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.readiness.currentGate, "launch_day_watch");
    assert.equal(output.readiness.launchStatus, "ready_for_launch_day_watch");
    assert.equal(output.readiness.canRunFullTestWindow, true);
    assert.equal(output.readiness.canSignoffProduction, true);
    assert.equal(output.nextStep.key, "reload_rehearsal_for_launch_day_watch");
    assert.equal(
      output.nextStep.command,
      `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
