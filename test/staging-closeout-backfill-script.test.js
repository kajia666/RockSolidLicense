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
  return spawnSync(process.execPath, ["scripts/staging-closeout-backfill.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runBackfillPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-backfill.mjs", ...args], {
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

function writeCloseoutInput(file) {
  const payload = {
    mode: "staging-closeout-input-draft",
    status: "awaiting_real_evidence",
    decision: null,
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: "pending_operator_entry",
      value: null,
      sourceStep: key === "operator_go_no_go" ? "backfill_filled_closeout_input" : `source_${key}`,
      artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`,
      receiptOperations: [],
      operatorNote: "Replace null with real redacted staging evidence."
    })),
    receiptVisibility: {},
    productionSignoff: {
      decision: null,
      conditions: []
    }
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("staging closeout backfill writes one evidence field without clearing remaining readiness", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:closeout:backfill"], "node scripts/staging-closeout-backfill.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\",\"exitCode\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--receipt-id",
      "receipt-route-map-001"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      status: "written",
      mode: "staging-closeout-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "closeout_evidence",
      key: "route_map_gate_result",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      receiptIds: ["receipt-route-map-001"],
      filledFieldCount: 1,
      remainingPlaceholderCount: 6,
      evidenceProgress: {
        status: "awaiting_more_closeout_evidence",
        requiredCount: 7,
        filledCount: 1,
        pendingCount: 6,
        currentTarget: {
          key: "backup_restore_drill_result",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
          sourceStep: "source_backup_restore_drill_result",
          receiptOperations: []
        },
        pendingKeys: [
          "backup_restore_drill_result",
          "live_write_smoke_result",
          "launch_smoke_handoff",
          "launch_mainline_evidence_receipts",
          "receipt_visibility_review",
          "operator_go_no_go"
        ],
        nextBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run nextBackfillCommand with real redacted evidence."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Refresh the readiness action queue after this evidence backfill."
        },
        {
          key: "next_closeout_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
          nextAction: "Backfill the next pending closeout evidence item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_next_closeout_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
          artifactPath: closeoutInputFile,
          nextAction: "Reload rehearsal after status confirms the next gate or all closeout evidence is ready."
        }
      ],
      nextAction: "Run statusCommand to pick the next closeout, full-test, or sign-off action."
    });

    const closeoutInput = JSON.parse(readFileSync(closeoutInputFile, "utf8"));
    const field = closeoutInput.acceptanceFields.find((item) => item.key === "route_map_gate_result");
    assert.equal(field.status, "filled");
    assert.deepEqual(field.value, {
      result: "pass",
      exitCode: 0,
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      receiptIds: ["receipt-route-map-001"]
    });
    assert.equal(closeoutInput.acceptanceFields.filter((item) => item.value !== null).length, 1);

    const rehearsal = runRehearsal([
      ...validRehearsalArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.filledFieldCount, 1);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.missingFieldCount, 6);
    assert.equal(rehearsalOutput.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-plain-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfillPlain([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\",\"exitCode\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--receipt-id",
      "receipt-route-map-001"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Closeout evidence backfilled: route_map_gate_result/);
    assert.match(result.stdout, /Backfilled target: closeout_evidence\/route_map_gate_result/);
    assert.match(result.stdout, /Backfilled artifact path: artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Backfilled receipt IDs: receipt-route-map-001/);
    assert.match(result.stdout, /Closeout evidence progress: 1\/7 filled, 6 pending/);
    assert.match(result.stdout, /Next closeout target: backup_restore_drill_result/);
    assert.match(result.stdout, /Next target artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt/);
    assert.match(result.stdout, /Next target source step: source_backup_restore_drill_result/);
    assert.match(result.stdout, /Next backfill command: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Backfilled status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Next backfill after status: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next action: Run statusCommand to pick the next closeout, full-test, or sign-off action\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill promotes object operator go/no-go evidence to the closeout decision", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-go-no-go-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--key",
      "operator_go_no_go",
      "--value-json",
      "{\"decision\":\"ready-for-full-test-window\",\"operator\":\"launch-duty\",\"summary\":\"redacted go/no-go approval\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const closeoutInput = JSON.parse(readFileSync(closeoutInputFile, "utf8"));
    assert.equal(closeoutInput.decision, "ready-for-full-test-window");
    const field = closeoutInput.acceptanceFields.find((item) => item.key === "operator_go_no_go");
    assert.equal(field.status, "filled");
    assert.deepEqual(field.value, {
      decision: "ready-for-full-test-window",
      operator: "launch-duty",
      summary: "redacted go/no-go approval",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
    });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill refuses unknown closeout keys", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-refuse-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--key",
      "unknown_key",
      "--value-json",
      "{\"result\":\"pass\"}"
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /unknown closeout key/i);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
