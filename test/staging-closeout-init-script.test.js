import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

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

function runCloseoutInit(args) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-init.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runCloseoutInitPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-init.mjs", ...args], {
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

function writeDraft(file, outputFile) {
  const keys = [
    "route_map_gate_result",
    "backup_restore_drill_result",
    "live_write_smoke_result",
    "launch_smoke_handoff",
    "launch_mainline_evidence_receipts",
    "receipt_visibility_review",
    "operator_go_no_go"
  ];
  const payload = {
    mode: "staging-closeout-input-draft",
    status: "draft_replace_before_use",
    exampleOnly: true,
    doNotSubmitWithoutReplacingPlaceholders: true,
    copyTo: outputFile,
    decision: null,
    acceptanceFields: keys.map((key) => ({
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

test("staging closeout init promotes a draft without clearing closeout readiness", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:closeout:init"], "node scripts/staging-closeout-init.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile);

    const result = runCloseoutInit([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
      "--actions-file",
      actionsFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(outputFile), true);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      status: "written",
      mode: "staging-closeout-init",
      draftFile,
      outputFile,
      actionsFile,
      acceptanceFieldCount: 7,
      placeholderCount: 7,
      evidenceProgress: {
        status: "awaiting_real_evidence",
        requiredCount: 7,
        filledCount: 0,
        pendingCount: 7,
        currentTarget: {
          key: "route_map_gate_result",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          sourceStep: "source_route_map_gate_result",
          receiptOperations: []
        },
        pendingKeys: [
          "route_map_gate_result",
          "backup_restore_drill_result",
          "live_write_smoke_result",
          "launch_smoke_handoff",
          "launch_mainline_evidence_receipts",
          "receipt_visibility_review",
          "operator_go_no_go"
        ],
        firstBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run firstBackfillCommand with real redacted evidence."
      },
      firstEvidenceBackfillHandoff: {
        status: "ready_for_first_closeout_backfill",
        currentActionKey: "backfill_closeout_evidence",
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
        firstBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
        firstBackfillTarget: {
          key: "route_map_gate_result",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          sourceStep: "source_route_map_gate_result",
          receiptOperations: []
        },
        actionQueueFile: actionsFile,
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
        nextAction: "Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Generate or refresh the readiness action queue before backfilling evidence."
        },
        {
          key: "first_closeout_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          nextAction: "Backfill the first pending closeout evidence item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_first_closeout_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
          artifactPath: outputFile,
          nextAction: "Reload rehearsal after the current evidence backfill item is recorded."
        }
      ],
      nextAction: "Run statusCommand to pick the first closeout evidence backfill target."
    });

    const closeoutInput = JSON.parse(readFileSync(outputFile, "utf8"));
    assert.equal(closeoutInput.mode, "staging-closeout-input-draft");
    assert.equal(closeoutInput.status, "awaiting_real_evidence");
    assert.equal(Object.hasOwn(closeoutInput, "exampleOnly"), false);
    assert.equal(Object.hasOwn(closeoutInput, "doNotSubmitWithoutReplacingPlaceholders"), false);
    assert.equal(closeoutInput.promotedFromDraft.path, draftFile);
    assert.equal(closeoutInput.acceptanceFields.every((field) => field.value === null), true);

    const rehearsal = runRehearsal([
      ...validRehearsalArgs,
      "--closeout-input-file",
      outputFile
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.draftPromotionStatus, "draft_needs_values");
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.safeToEnterFullTestWindow, false);
    assert.equal(rehearsalOutput.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout init prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-plain-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile);

    const result = runCloseoutInitPlain([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
      "--actions-file",
      actionsFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Filled closeout input initialized: .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Evidence progress: 0\/7 filled, 7 pending/);
    assert.match(result.stdout, /First backfill target: route_map_gate_result/);
    assert.match(result.stdout, /First target artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt/);
    assert.match(result.stdout, /First target source step: source_route_map_gate_result/);
    assert.match(result.stdout, /First backfill command: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First target status check: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence handoff: ready_for_first_closeout_backfill/);
    assert.match(result.stdout, /First evidence status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence backfill: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence target: route_map_gate_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt/);
    assert.match(result.stdout, /First evidence source step: source_route_map_gate_result/);
    assert.match(result.stdout, /First evidence rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /First evidence next action: Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload\./);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First backfill after status: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next action: Run statusCommand to pick the first closeout evidence backfill target\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout init refuses non-draft closeout inputs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-refuse-"));
  try {
    const draftFile = join(tempDir, "not-a-draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    writeFileSync(
      draftFile,
      `${JSON.stringify({ mode: "staging-closeout-template", exampleOnly: true }, null, 2)}\n`,
      "utf8"
    );

    const result = runCloseoutInit([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /staging-closeout-input-draft/i);
    assert.equal(existsSync(outputFile), false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
