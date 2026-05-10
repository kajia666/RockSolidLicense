import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runStatusPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-readiness-status.mjs", ...args], {
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
    assert.deepEqual(
      output.actionQueue.map((item) => [item.key, item.phase, item.status, item.targetKey]),
      closeoutKeys.slice(1).map((key, index) => [
        "backfill_closeout_evidence",
        "pre_full_test_closeout",
        index === 0 ? "current" : "blocked_after_prior_actions",
        key
      ])
    );
    assert.equal(
      output.actionQueue[0].statusCommand,
      `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`
    );
    assert.deepEqual(output.actionQueue[0].evidence, {
      expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result.",
      valueJsonExample: {
        result: "pass",
        restoreDryRun: "pass",
        healthcheck: "pass",
        summary: "<redacted operator summary>"
      },
      artifactPathHint: "artifacts/staging/<productCode>/<channel>/backup-restore-drill.txt",
      receiptOperations: ["record_recovery_drill", "record_backup_verification"],
      receiptIdHint: "Attach receipt IDs produced by: record_recovery_drill, record_backup_verification."
    });
    assert.equal(
      output.actionQueue[0].exampleCommand,
      `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key backup_restore_drill_result --value-json '{"result":"pass","restoreDryRun":"pass","healthcheck":"pass","summary":"<redacted operator summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id>`
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
    assert.deepEqual(output.fullTestWindowHandoff, {
      status: "ready_for_full_test_window",
      currentActionKey: "run_full_test_window",
      targetKey: "full_test_window_passed",
      fullTestCommand: "npm.cmd test",
      fullTestResultArtifactPath: "artifacts/staging/<productCode>/<channel>/full-test-output.txt",
      signoffBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff`,
      signoffBackfillExampleCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json '{"result":"pass","command":"npm.cmd test","failureCount":0,"summary":"<redacted test summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/full-test-output.txt --decision ready-for-production-signoff`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
      reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`,
      actionQueueFile: null,
      expectedEvidence: "Attach the full `npm.cmd test` output summary and failure count.",
      receiptOperations: [],
      nextAction: "Run fullTestCommand, save fullTestResultArtifactPath, run signoffBackfillCommand with the redacted full-test result, then statusCommand."
    });
    assert.deepEqual(output.operatorNextCommands, [
      {
        key: "run_full_test_window",
        status: "current",
        phase: "full_test_window",
        actionKey: "run_full_test_window",
        targetKey: "full_test_window_passed",
        command: "npm.cmd test",
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
        artifactPathHint: "artifacts/staging/<productCode>/<channel>/full-test-output.txt",
        receiptOperations: [],
        nextAction: "Run the full test window and save the redacted output artifact before backfilling full_test_window_passed."
      },
      {
        key: "backfill_full_test_result",
        status: "blocked_after_full_test_window",
        phase: "production_signoff",
        actionKey: "backfill_full_test_window_passed",
        targetKey: "full_test_window_passed",
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff`,
        exampleCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json '{"result":"pass","command":"npm.cmd test","failureCount":0,"summary":"<redacted test summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/full-test-output.txt --decision ready-for-production-signoff`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
        artifactPathHint: "artifacts/staging/<productCode>/<channel>/full-test-output.txt",
        receiptOperations: [],
        nextAction: "Backfill full_test_window_passed, then rerun staging:readiness:status."
      },
      {
        key: "refresh_readiness_status",
        status: "blocked_after_full_test_backfill",
        phase: "production_signoff",
        actionKey: "refresh_readiness_status",
        targetKey: null,
        command: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
        artifactPathHint: null,
        receiptOperations: [],
        nextAction: "Refresh readiness status to continue production sign-off evidence."
      }
    ]);
    assert.deepEqual(output.actionQueue, [
      {
        key: "run_full_test_window",
        phase: "full_test_window",
        status: "current",
        targetKey: "full_test_window_passed",
        command: "npm.cmd test",
        followUpCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff`,
        followUpExampleCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key full_test_window_passed --value-json '{"result":"pass","command":"npm.cmd test","failureCount":0,"summary":"<redacted test summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/full-test-output.txt --decision ready-for-production-signoff`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
        evidence: {
          expectedEvidence: "Attach the full `npm.cmd test` output summary and failure count.",
          valueJsonExample: {
            result: "pass",
            command: "npm.cmd test",
            failureCount: 0,
            summary: "<redacted test summary>"
          },
          artifactPathHint: "artifacts/staging/<productCode>/<channel>/full-test-output.txt",
          receiptOperations: [],
          receiptIdHint: "No Launch Mainline receipt is required for this condition unless your operating process records one."
        }
      }
    ]);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status plain output prints full-test operator next commands", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-full-test-plain-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window"
    });

    const result = runStatusPlain(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Current gate: full_test_window/);
    assert.match(result.stdout, /Operator next current: run_full_test_window -> npm\.cmd test/);
    assert.match(result.stdout, /Operator next current artifact: artifacts\/staging\/<productCode>\/<channel>\/full-test-output\.txt/);
    assert.match(result.stdout, /Operator next blocked_after_full_test_window: backfill_full_test_window_passed -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next blocked_after_full_test_window example: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key full_test_window_passed --value-json '\{"result":"pass","command":"npm\.cmd test","failureCount":0,"summary":"<redacted test summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/full-test-output\.txt --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next blocked_after_full_test_window artifact: artifacts\/staging\/<productCode>\/<channel>\/full-test-output\.txt/);
    assert.match(result.stdout, /Operator next blocked_after_full_test_backfill: refresh_readiness_status -> npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Full-test handoff: ready_for_full_test_window/);
    assert.match(result.stdout, /Full-test current action: run_full_test_window/);
    assert.match(result.stdout, /Full-test command: npm\.cmd test/);
    assert.match(result.stdout, /Full-test result artifact: artifacts\/staging\/<productCode>\/<channel>\/full-test-output\.txt/);
    assert.match(result.stdout, /Full-test signoff backfill: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key full_test_window_passed --value-json <redacted-json> --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Full-test signoff example: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key full_test_window_passed --value-json '\{"result":"pass","command":"npm\.cmd test","failureCount":0,"summary":"<redacted test summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/full-test-output\.txt --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Full-test status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Full-test rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Full-test next action: Run fullTestCommand, save fullTestResultArtifactPath, run signoffBackfillCommand with the redacted full-test result, then statusCommand\./);
    assert.match(result.stdout, /Action file: .*readiness-action-queue\.md/);
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
    assert.equal(output.operatorNextCommands.length, 10);
    assert.deepEqual(output.operatorNextCommands[0], {
      key: "backfill_production_signoff",
      status: "current",
      phase: "production_signoff",
      actionKey: "backfill_production_signoff",
      targetKey: "staging_artifacts_archived",
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key staging_artifacts_archived --value-json <redacted-json>`,
      exampleCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key staging_artifacts_archived --value-json '{"result":"confirmed","summary":"<redacted operator summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/staging-artifacts-archive.txt`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`,
      artifactPathHint: "artifacts/staging/<productCode>/<channel>/staging-artifacts-archive.txt",
      receiptOperations: [],
      nextAction: "Backfill staging_artifacts_archived, then rerun staging:readiness:status."
    });
    assert.equal(output.operatorNextCommands.at(-1).key, "backfill_receipt_visibility");
    assert.equal(output.operatorNextCommands.at(-1).targetKey, "launchOpsOverviewStatus");
    assert.equal(output.operatorNextCommands.at(-1).status, "blocked_after_prior_actions");
    assert.deepEqual(
      output.actionQueue.map((item) => [item.key, item.phase, item.status, item.targetKey]),
      [
        ...signoffKeys.slice(1).map((key, index) => [
          "backfill_production_signoff",
          "production_signoff",
          index === 0 ? "current" : "blocked_after_prior_actions",
          key
        ]),
        ...receiptVisibilityKeys.slice(1).map((key) => [
          "backfill_receipt_visibility",
          "receipt_visibility",
          "blocked_after_prior_actions",
          key
        ])
      ]
    );
    assert.equal(
      output.actionQueue.at(-1).command,
      `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane launchOpsOverviewStatus --value-json <redacted-json>`
    );
    assert.deepEqual(output.actionQueue[0].evidence, {
      expectedEvidence: "Confirm the artifact/receipt ledger archive paths exist and contain redacted artifacts.",
      valueJsonExample: {
        result: "confirmed",
        summary: "<redacted operator summary>"
      },
      artifactPathHint: "artifacts/staging/<productCode>/<channel>/staging-artifacts-archive.txt",
      receiptOperations: [],
      receiptIdHint: "Attach receipt IDs if your operating process records this sign-off in Launch Mainline."
    });
    assert.equal(
      output.actionQueue[0].exampleCommand,
      `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key staging_artifacts_archived --value-json '{"result":"confirmed","summary":"<redacted operator summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/staging-artifacts-archive.txt`
    );
    assert.deepEqual(output.actionQueue.at(-1).evidence, {
      expectedEvidence: "Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover.",
      valueJsonExample: {
        status: "visible",
        summaryPath: "<redacted receipt visibility summary path>",
        summary: "<redacted operator summary>"
      },
      artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-ops-overview-status-receipt-visibility.json",
      receiptOperations: ["record_post_launch_ops_sweep"],
      receiptIdHint: "Attach the latest receipt ID for record_post_launch_ops_sweep when available."
    });
    assert.equal(
      output.actionQueue.at(-1).exampleCommand,
      `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane launchOpsOverviewStatus --value-json '{"status":"visible","summaryPath":"<redacted receipt visibility summary path>","summary":"<redacted operator summary>"}' --artifact-path artifacts/staging/<productCode>/<channel>/launch-ops-overview-status-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id>`
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status plain output prints production signoff artifact and example hints", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-signoff-plain-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: ["full_test_window_passed"],
      visibleReceiptLanes: ["launchMainline"]
    });

    const result = runStatusPlain(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Current gate: production_signoff/);
    assert.match(result.stdout, /Operator next current: backfill_production_signoff -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next current example: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json '\{"result":"confirmed","summary":"<redacted operator summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next current artifact: artifacts\/staging\/<productCode>\/<channel>\/staging-artifacts-archive\.txt/);
    assert.match(result.stdout, /Operator next current status check: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next current next action: Backfill staging_artifacts_archived, then rerun staging:readiness:status\./);
    assert.match(result.stdout, /Operator next blocked_after_prior_actions: backfill_receipt_visibility -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --receipt-lane launchOpsOverviewStatus --value-json <redacted-json> --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next blocked_after_prior_actions example: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --receipt-lane launchOpsOverviewStatus --value-json '\{"status":"visible","summaryPath":"<redacted receipt visibility summary path>","summary":"<redacted operator summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/launch-ops-overview-status-receipt-visibility\.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next blocked_after_prior_actions artifact: artifacts\/staging\/<productCode>\/<channel>\/launch-ops-overview-status-receipt-visibility\.json/);
    assert.match(result.stdout, /Operator next blocked_after_prior_actions receipts: record_post_launch_ops_sweep/);
    assert.match(result.stdout, /Action file: .*readiness-action-queue\.md/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status summarizes filled evidence details after backfill", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-evidence-summary-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: ["route_map_gate_result"],
      filledSignoffKeys: ["full_test_window_passed"],
      visibleReceiptLanes: ["launchMainline"]
    });
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    const routeMapField = payload.acceptanceFields.find((item) => item.key === "route_map_gate_result");
    routeMapField.value = {
      result: "pass",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      receiptIds: ["receipt-route-map-001"]
    };
    routeMapField.artifactPath = "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt";
    routeMapField.receiptIds = ["receipt-route-map-001"];
    const fullTestField = payload.productionSignoff.conditions.find((item) => item.key === "full_test_window_passed");
    fullTestField.value = {
      result: "pass",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      receiptIds: ["receipt-full-test-001"]
    };
    fullTestField.artifactPath = "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt";
    fullTestField.receiptIds = ["receipt-full-test-001"];
    payload.receiptVisibility.launchMainline = {
      status: "visible",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
      receiptIds: ["receipt-launch-mainline-001"]
    };
    writeFileSync(inputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const result = runStatus(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.evidenceSummary, {
      closeout: {
        requiredCount: 7,
        filledCount: 1,
        missingCount: 6,
        filledItems: [
          {
            key: "route_map_gate_result",
            status: "filled",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
            receiptIds: ["receipt-route-map-001"]
          }
        ]
      },
      productionSignoff: {
        requiredConditionCount: 7,
        filledConditionCount: 1,
        missingConditionCount: 6,
        filledConditions: [
          {
            key: "full_test_window_passed",
            status: "filled",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
            receiptIds: ["receipt-full-test-001"]
          }
        ]
      },
      receiptVisibility: {
        requiredLaneCount: 5,
        visibleLaneCount: 1,
        missingLaneCount: 4,
        visibleLanes: [
          {
            key: "launchMainline",
            status: "visible",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
            receiptIds: ["receipt-launch-mainline-001"]
          }
        ]
      }
    });
    const markdown = readFileSync(actionsFile, "utf8");
    assert.match(markdown, /## Evidence Progress/);
    assert.match(markdown, /Closeout evidence: `1\/7` filled, `6` missing/);
    assert.match(markdown, /- closeout `route_map_gate_result`: artifact `artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt`; receipts `receipt-route-map-001`/);
    assert.match(markdown, /Production sign-off evidence: `1\/7` filled, `6` missing/);
    assert.match(markdown, /- production sign-off `full_test_window_passed`: artifact `artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt`; receipts `receipt-full-test-001`/);
    assert.match(markdown, /Receipt visibility: `1\/5` visible, `4` missing/);
    assert.match(markdown, /- receipt visibility `launchMainline`: artifact `artifacts\/staging\/PILOT_ALPHA\/stable\/launch-mainline-receipt-visibility\.json`; receipts `receipt-launch-mainline-001`/);

    const plain = runStatusPlain(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    assert.equal(plain.stderr, "");
    assert.match(plain.stdout, /Evidence progress closeout: 1\/7 filled, 6 missing/);
    assert.match(plain.stdout, /Evidence filled closeout route_map_gate_result: artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt receipts=receipt-route-map-001/);
    assert.match(plain.stdout, /Evidence progress production signoff: 1\/7 filled, 6 missing/);
    assert.match(plain.stdout, /Evidence filled production signoff full_test_window_passed: artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt receipts=receipt-full-test-001/);
    assert.match(plain.stdout, /Evidence progress receipt visibility: 1\/5 visible, 4 missing/);
    assert.match(plain.stdout, /Evidence visible receipt launchMainline: artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-mainline-receipt-visibility\.json receipts=receipt-launch-mainline-001/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status treats object operator go/no-go evidence as the full-test decision", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-go-no-go-object-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys
    });
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    payload.decision = null;
    payload.acceptanceFields = payload.acceptanceFields.map((field) => field.key === "operator_go_no_go"
      ? {
        ...field,
        value: {
          decision: "ready-for-full-test-window",
          operator: "launch-duty",
          summary: "redacted go/no-go approval"
        }
      }
      : field);
    writeFileSync(inputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const result = runStatus(["--input-file", inputFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.readiness.closeout.decision, "ready-for-full-test-window");
    assert.equal(output.readiness.currentGate, "full_test_window");
    assert.equal(output.readiness.canRunFullTestWindow, true);
    assert.equal(output.actionQueue[0].key, "run_full_test_window");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status infers artifact root from a staging closeout input path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-artifact-root-"));
  try {
    const inputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    mkdirSync(dirname(inputFile), { recursive: true });
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: ["route_map_gate_result"]
    });

    const result = runStatus(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.artifactPathRoot, {
      status: "inferred",
      path: "artifacts/staging/PILOT_ALPHA/stable",
      source: "input-file"
    });
    assert.equal(
      output.actionQueue[0].evidence.artifactPathHint,
      "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt"
    );
    assert.equal(
      output.actionQueue[0].exampleCommand,
      `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key backup_restore_drill_result --value-json '{"result":"pass","restoreDryRun":"pass","healthcheck":"pass","summary":"<redacted operator summary>"}' --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id> --actions-file ${actionsFile}`
    );
    const markdown = readFileSync(actionsFile, "utf8");
    assert.match(markdown, /Artifact path hint: `artifacts\/staging\/PILOT_ALPHA\/stable\/backup-restore-drill\.txt`/);
    assert.doesNotMatch(markdown, /<productCode>|<channel>/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status can write a redacted markdown action queue", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-actions-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "handoff", "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: ["full_test_window_passed"],
      visibleReceiptLanes: ["launchMainline"]
    });

    const result = runStatus(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(actionsFile), true);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.actionsFile, {
      path: actionsFile,
      status: "written",
      itemCount: 10,
      currentCount: 1,
      rerunCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile} --actions-file ${actionsFile}`,
      nextAction: "Open the action file, complete the current item, then rerun staging:readiness:status."
    });
    const markdown = readFileSync(actionsFile, "utf8");
    assert.match(markdown, /^# Staging Readiness Action Queue/m);
    assert.match(markdown, /Input file: `.*filled-closeout-input\.json`/);
    assert.match(markdown, /Current gate: `production_signoff`/);
    assert.match(markdown, /Launch status: `blocked`/);
    assert.match(markdown, /1\. \[current\] `production_signoff` -> `staging_artifacts_archived`/);
    assert.match(markdown, /Expected evidence: Confirm the artifact\/receipt ledger archive paths exist and contain redacted artifacts\./);
    assert.match(markdown, /Value JSON example: `{"result":"confirmed","summary":"<redacted operator summary>"}`/);
    assert.match(markdown, /Artifact path hint: `artifacts\/staging\/<productCode>\/<channel>\/staging-artifacts-archive\.txt`/);
    assert.match(markdown, /Command: `npm\.cmd run staging:signoff:backfill -- --input-file .* --condition-key staging_artifacts_archived --value-json <redacted-json> --actions-file .*readiness-action-queue\.md`/);
    assert.match(markdown, /Example command: `npm\.cmd run staging:signoff:backfill -- --input-file .* --condition-key staging_artifacts_archived --value-json '\{"result":"confirmed","summary":"<redacted operator summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md`/);
    assert.match(markdown, /10\. \[blocked_after_prior_actions\] `receipt_visibility` -> `launchOpsOverviewStatus`/);
    assert.match(markdown, /Receipt operations: record_post_launch_ops_sweep/);
    assert.match(markdown, /Example command: `npm\.cmd run staging:signoff:backfill -- --input-file .* --receipt-lane launchOpsOverviewStatus --value-json '\{"status":"visible","summaryPath":"<redacted receipt visibility summary path>","summary":"<redacted operator summary>"\}' --artifact-path artifacts\/staging\/<productCode>\/<channel>\/launch-ops-overview-status-receipt-visibility\.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file .*readiness-action-queue\.md`/);
    assert.match(markdown, /Status check: `npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md`/);
    assert.doesNotMatch(markdown, /StrongAdmin|StrongDeveloper|Bearer|password/i);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status reports launch-day watch readiness after all local gates are clear", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-ready-"));
  try {
    const inputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    mkdirSync(dirname(inputFile), { recursive: true });
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: signoffKeys,
      visibleReceiptLanes: receiptVisibilityKeys
    });

    const result = runStatus(["--input-file", inputFile, "--actions-file", actionsFile]);

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
    assert.deepEqual(output.launchDutyNextRun, {
      status: "ready_for_launch_day_watch",
      currentActionKey: "archive_production_signoff",
      reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`,
      actionKeys: [
        "archive_production_signoff",
        "record_launch_day_watch_summary",
        "close_first_wave"
      ],
      artifactPathHints: {
        launchDayWatchSummary: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
        firstWaveCloseout: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
      },
      productionSignoffArchive: {
        actionKey: "archive_production_signoff",
        packetPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
        archiveIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json",
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`,
        nextAction: "Run reloadCommand, archive the production sign-off packet, then record launch_day_watch_summary."
      },
      postArchiveEvidenceActions: [
        {
          key: "record_launch_day_watch_summary",
          status: "blocked_after_rehearsal_reload",
          phase: "launch_day_watch",
          actionKey: "record_launch_day_watch_summary",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
          receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
          sourceRecordKeys: [],
          expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions.",
          nextAction: "Record launch-day watch summary and attach the cutover/readiness receipt IDs after the rehearsal packet is regenerated."
        },
        {
          key: "close_first_wave",
          status: "blocked_after_launch_day_watch_summary",
          phase: "first_wave_closeout",
          actionKey: "close_first_wave",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
          receiptOperations: ["record_launch_closeout_review"],
          sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
          expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
          nextAction: "Close the first wave after incident, rollback, and stabilization owner records are attached."
        }
      ],
      receiptOperations: {
        launchDayWatchSummary: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
        firstWaveCloseout: ["record_launch_closeout_review"]
      },
      sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
      nextAction: "Run the rehearsal reload, archive production sign-off, then record launch-day watch summary before first-wave closeout."
    });
    assert.deepEqual(output.operatorNextCommands, [
      {
        key: "reload_rehearsal_for_launch_day_watch",
        status: "current",
        phase: "launch_day_watch",
        actionKey: "archive_production_signoff",
        command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile} --actions-file ${actionsFile}`,
        artifactPathHint: null,
        receiptOperations: [],
        sourceRecordKeys: [],
        nextAction: "Reload rehearsal, archive the production sign-off packet, then use the generated launch-duty packet for watch evidence."
      },
      {
        key: "record_launch_day_watch_summary",
        status: "blocked_after_rehearsal_reload",
        phase: "launch_day_watch",
        actionKey: "record_launch_day_watch_summary",
        command: null,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile} --actions-file ${actionsFile}`,
        artifactPathHint: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
        receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
        sourceRecordKeys: [],
        nextAction: "Record launch-day watch summary and attach the cutover/readiness receipt IDs after the rehearsal packet is regenerated."
      },
      {
        key: "close_first_wave",
        status: "blocked_after_launch_day_watch_summary",
        phase: "first_wave_closeout",
        actionKey: "close_first_wave",
        command: null,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${inputFile} --actions-file ${actionsFile}`,
        artifactPathHint: "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md",
        receiptOperations: ["record_launch_closeout_review"],
        sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
        nextAction: "Close the first wave after incident, rollback, and stabilization owner records are attached."
      }
    ]);
    assert.deepEqual(
      output.actionQueue.map((item) => [item.key, item.phase, item.status, item.targetKey, item.actionKey]),
      [
        ["reload_rehearsal_for_launch_day_watch", "launch_day_watch", "current", null, "archive_production_signoff"],
        ["record_launch_day_watch_summary", "launch_day_watch", "blocked_after_prior_actions", "launch_day_watch_summary", "record_launch_day_watch_summary"],
        ["close_first_wave", "first_wave_closeout", "blocked_after_prior_actions", "first_wave_closeout", "close_first_wave"]
      ]
    );
    assert.equal(
      output.actionQueue[1].evidence.artifactPathHint,
      "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"
    );
    assert.deepEqual(
      output.actionQueue[1].evidence.receiptOperations,
      ["record_cutover_walkthrough", "record_launch_day_readiness_review"]
    );
    assert.equal(
      output.actionQueue[2].evidence.artifactPathHint,
      "artifacts/staging/PILOT_ALPHA/stable/first-wave-closeout.md"
    );
    assert.deepEqual(
      output.actionQueue[2].sourceRecordKeys,
      ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
    );
    assert.equal(output.actionsFile.itemCount, 3);
    const markdown = readFileSync(actionsFile, "utf8");
    assert.match(markdown, /## Launch Duty Next Run/);
    assert.match(markdown, /Launch-duty status: `ready_for_launch_day_watch`/);
    assert.match(markdown, /Current action key: `archive_production_signoff`/);
    assert.match(markdown, /Reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json`/);
    assert.match(markdown, /Production sign-off packet: `artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json`/);
    assert.match(markdown, /Launch-duty archive index: `artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json`/);
    assert.match(markdown, /Archive next action: Run reloadCommand, archive the production sign-off packet, then record launch_day_watch_summary\./);
    assert.match(markdown, /Post-archive evidence actions: record_launch_day_watch_summary -> close_first_wave/);
    assert.match(markdown, /Post-archive evidence record_launch_day_watch_summary: `artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md` receipts `record_cutover_walkthrough, record_launch_day_readiness_review` sources `-`/);
    assert.match(markdown, /Post-archive evidence close_first_wave: `artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md` receipts `record_launch_closeout_review` sources `first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff`/);
    assert.match(markdown, /Follow-up action keys: archive_production_signoff, record_launch_day_watch_summary, close_first_wave/);
    assert.match(markdown, /Watch artifact: `artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md`/);
    assert.match(markdown, /First-wave closeout artifact: `artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md`/);
    assert.match(markdown, /Operator next commands:/);
    assert.match(markdown, /current: archive_production_signoff -> `npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json`/);
    assert.match(markdown, /blocked_after_rehearsal_reload: record_launch_day_watch_summary -> `artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md`/);
    assert.match(markdown, /blocked_after_launch_day_watch_summary: close_first_wave -> `artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md`/);
    assert.match(markdown, /1\. \[current\] `launch_day_watch` -> `none`/);
    assert.match(markdown, /Action key: `archive_production_signoff`/);
    assert.match(markdown, /2\. \[blocked_after_prior_actions\] `launch_day_watch` -> `launch_day_watch_summary`/);
    assert.match(markdown, /Action key: `record_launch_day_watch_summary`/);
    assert.match(markdown, /Artifact path hint: `artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md`/);
    assert.match(markdown, /Receipt operations: record_cutover_walkthrough, record_launch_day_readiness_review/);
    assert.match(markdown, /3\. \[blocked_after_prior_actions\] `first_wave_closeout` -> `first_wave_closeout`/);
    assert.match(markdown, /Action key: `close_first_wave`/);
    assert.match(markdown, /Source records: first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging readiness status prints launch-duty next run in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-readiness-status-plain-ready-"));
  try {
    const inputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    mkdirSync(dirname(inputFile), { recursive: true });
    writeCloseoutInput(inputFile, {
      filledCloseoutKeys: closeoutKeys,
      decision: "ready-for-full-test-window",
      productionDecision: "ready-for-production-signoff",
      filledSignoffKeys: signoffKeys,
      visibleReceiptLanes: receiptVisibilityKeys
    });

    const result = runStatusPlain(["--input-file", inputFile, "--actions-file", actionsFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Current gate: launch_day_watch/);
    assert.match(result.stdout, /Next step: reload_rehearsal_for_launch_day_watch/);
    assert.match(result.stdout, /Launch duty current action: archive_production_signoff/);
    assert.match(result.stdout, /Launch duty reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Launch duty production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Launch duty archive index: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(result.stdout, /Launch duty archive next action: Run reloadCommand, archive the production sign-off packet, then record launch_day_watch_summary\./);
    assert.match(result.stdout, /Launch duty post-archive evidence actions: record_launch_day_watch_summary -> close_first_wave/);
    assert.match(result.stdout, /Launch duty post-archive evidence record_launch_day_watch_summary: artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md receipts=record_cutover_walkthrough, record_launch_day_readiness_review sources=-/);
    assert.match(result.stdout, /Launch duty post-archive evidence close_first_wave: artifact=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md receipts=record_launch_closeout_review sources=first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
    assert.match(result.stdout, /Operator next current: archive_production_signoff -> npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Operator next current status check: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator next current next action: Reload rehearsal, archive the production sign-off packet, then use the generated launch-duty packet for watch evidence\./);
    assert.match(result.stdout, /Operator next blocked_after_rehearsal_reload: record_launch_day_watch_summary -> artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(result.stdout, /Operator next blocked_after_rehearsal_reload receipts: record_cutover_walkthrough, record_launch_day_readiness_review/);
    assert.match(result.stdout, /Operator next blocked_after_rehearsal_reload next action: Record launch-day watch summary and attach the cutover\/readiness receipt IDs after the rehearsal packet is regenerated\./);
    assert.match(result.stdout, /Operator next blocked_after_launch_day_watch_summary: close_first_wave -> artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Operator next blocked_after_launch_day_watch_summary receipts: record_launch_closeout_review/);
    assert.match(result.stdout, /Operator next blocked_after_launch_day_watch_summary source records: first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
    assert.match(result.stdout, /Operator next blocked_after_launch_day_watch_summary next action: Close the first wave after incident, rollback, and stabilization owner records are attached\./);
    assert.match(result.stdout, /Launch duty follow-up actions: archive_production_signoff -> record_launch_day_watch_summary -> close_first_wave/);
    assert.match(result.stdout, /Launch duty watch artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(result.stdout, /Launch duty watch receipts: record_cutover_walkthrough, record_launch_day_readiness_review/);
    assert.match(result.stdout, /Launch duty first-wave closeout: artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch duty first-wave receipts: record_launch_closeout_review/);
    assert.match(result.stdout, /Launch duty first-wave source records: first_wave_incident_log, rollback_signal_review, stabilization_owner_handoff/);
    assert.match(result.stdout, /Launch duty next action: Run the rehearsal reload, archive production sign-off, then record launch-day watch summary before first-wave closeout\./);
    assert.match(result.stdout, /Action file: .*readiness-action-queue\.md/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
