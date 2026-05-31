import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runRecord(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-launch-duty-record.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
  });
}

function runRecordPlain(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-launch-duty-record.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
  });
}

function launchDutyArtifactPath(artifactRoot, key) {
  const fileNames = {
    launch_day_watch_summary: "launch-day-watch-summary.md",
    receipt_visibility_snapshot: "receipt-visibility-snapshot.txt",
    first_wave_incident_log: "first-wave-incident-log.md",
    rollback_signal_review: "rollback-signal-review.md",
    stabilization_owner_handoff: "stabilization-owner-handoff.md",
    first_wave_closeout: "first-wave-closeout.md"
  };
  return join(artifactRoot, fileNames[key]);
}

function evidenceItemByKey(gate, key) {
  return (gate.evidenceItems || []).find((item) => item.key === key);
}

function buildExpectedProductionSwitchProofPacket({
  closeoutInputFile,
  actionsFile,
  archiveRoot,
  currentActionKey,
  currentCommand,
  launchDutyStatus,
  launchDutyArtifactPath,
  launchDutyCommand = launchDutyStatus.startsWith("ready_") ? null : currentCommand
}) {
  const proofItems = [
    {
      order: 1,
      key: "public_https_entrypoint",
      status: "pending_real_environment_value",
      command: null,
      artifactPath: null,
      nextAction: "Keep the public staging entrypoint on HTTPS for all live-write smoke and launch switch checks."
    },
    {
      order: 2,
      key: "non_default_secret_env",
      status: "pending_real_environment_confirmation",
      command: null,
      artifactPath: null,
      nextAction: "Confirm non-default admin, developer, and bearer-token secrets are loaded from environment variables before continuing evidence backfill."
    },
    {
      order: 3,
      key: "storage_profile_selected",
      status: "pending_real_environment_value",
      command: null,
      artifactPath: null,
      nextAction: "Keep storage profile and backup paths aligned through recovery preflight and staging evidence backfill."
    },
    {
      order: 4,
      key: "backup_restore_drill",
      status: "ready_evidence_attached",
      command: null,
      artifactPath: join(archiveRoot, "backup_restore_drill_result.txt"),
      nextAction: "Attach backup/restore drill evidence before live-write smoke and production sign-off."
    },
    {
      order: 5,
      key: "live_write_smoke",
      status: "ready_evidence_attached",
      command: null,
      artifactPath: join(archiveRoot, "live_write_smoke_result.txt"),
      nextAction: "Attach launch:smoke:staging output after no-write preflight and route-map gate pass."
    },
    {
      order: 6,
      key: "full_test_window",
      status: "ready_evidence_attached",
      command: "npm.cmd test",
      artifactPath: join(archiveRoot, "full-test-output.txt"),
      nextAction: "Attach the redacted full-suite output artifact before or while backfilling full_test_window_passed."
    },
    {
      order: 7,
      key: "production_signoff_and_receipts",
      status: "ready_evidence_attached",
      command: null,
      artifactPath: join(archiveRoot, "staging-production-signoff-packet.json"),
      nextAction: "Backfill production sign-off conditions and receipt visibility lanes before launch-day watch."
    },
    {
      order: 8,
      key: "launch_day_watch_and_stabilization",
      status: launchDutyStatus,
      command: launchDutyCommand,
      artifactPath: launchDutyArtifactPath,
      nextAction: "Record launch-day watch, stabilization, and first-wave closeout records into the shared launch-duty record index."
    }
  ];
  const ready = proofItems.filter((item) => item.status.startsWith("ready_")).length;
  return {
    version: "staging-launch-duty-record-production-switch-proof-packet/v1",
    status: "blocked_until_real_environment_evidence",
    currentActionKey,
    currentCommand,
    baseUrl: null,
    productCode: "PILOT_ALPHA",
    channel: "stable",
    targetOs: null,
    storageProfile: null,
    archiveRoot,
    closeoutInputFile,
    readinessActionQueueFile: actionsFile,
    launchDutyRecordIndexFile: join(archiveRoot, "launch-duty-record-index.json"),
    publicHttpsProof: {
      status: "pending_real_environment_value",
      baseUrl: null,
      scheme: null,
      isHttps: false,
      currentActionKey: "set_public_https_entrypoint",
      nextAction: "Set a public HTTPS base URL before continuing production switch proof."
    },
    storageProfileProof: {
      status: "pending_real_environment_value",
      storageProfile: null,
      isSelected: false,
      currentActionKey: "select_storage_profile",
      nextAction: "Select the storage profile before continuing production switch proof."
    },
    backupRestoreDrillProof: {
      status: "ready_evidence_attached",
      closeoutKey: "backup_restore_drill_result",
      closeoutInputFile: closeoutInputFile,
      artifactPath: join(archiveRoot, "backup_restore_drill_result.txt"),
      command: null,
      receiptOperations: [],
      currentActionKey: "confirm_backup_restore_drill_evidence",
      nextAction: "Backup/restore drill evidence is attached; keep receipt links visible through production sign-off and launch-duty review."
    },
    secretEnvProof: {
      status: "pending_real_environment_confirmation",
      requiredKeys: [],
      presentKeys: [],
      missingKeys: [],
      requiredCount: 0,
      missingCount: 0,
      currentMissingKey: null,
      targetEnvFile: null,
      currentActionKey: "bind_required_secret_env",
      nextAction: "Bind the required secret environment variable names before continuing production switch proof."
    },
    localFullSuiteBaseline: {
      command: "npm.cmd test",
      status: "available_from_2026-05-28_full_suite_pass",
      testCount: 198,
      failureCount: 0,
      outputArtifact: join(archiveRoot, "full-test-output.txt"),
      nextAction: "Reuse this local baseline unless another meaningful backend/API or launch-control change lands before cutover."
    },
    proofCounts: {
      total: 8,
      ready,
      blocked: 8 - ready
    },
    proofItems,
    nextAction: "Continue the current launch-duty command, rerun staging:readiness:status, then use this packet as the production switch proof checklist."
  };
}

function recordLaunchDutySequence({ closeoutInputFile, actionsFile, recordIndexFile, artifactRoot, keys }) {
  for (const key of keys) {
    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      key,
      "--artifact-path",
      launchDutyArtifactPath(artifactRoot, key),
      "--value-json",
      `{"result":"recorded","summary":"redacted ${key}"}`,
      "--record-index-file",
      recordIndexFile
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

test("staging launch duty record writes a watch summary artifact and next command", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:launch-duty:record"], "node scripts/staging-launch-duty-record.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-watch-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    const artifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-day-watch-summary.md");
    const recordIndexFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-duty-record-index.json");

    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "launch_day_watch_summary",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"recorded\",\"watchWindow\":\"T-30m through T+2h\",\"summary\":\"redacted cutover watch\"}",
      "--receipt-id",
      "receipt-cutover-001",
      "--receipt-id",
      "receipt-readiness-001"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(artifactPath), true);
    assert.equal(existsSync(recordIndexFile), true);
    const artifact = readFileSync(artifactPath, "utf8");
    assert.match(artifact, /^# Staging Launch Duty Record/m);
    assert.match(artifact, /Key: `launch_day_watch_summary`/);
    assert.match(artifact, /Action key: `record_launch_day_watch_summary`/);
    assert.match(artifact, /Receipt IDs: `receipt-cutover-001, receipt-readiness-001`/);
    assert.match(artifact, /"summary": "redacted cutover watch"/);
    assert.doesNotMatch(artifact, /Bearer|password|StrongAdmin|StrongDeveloper/i);

    const recordIndex = JSON.parse(readFileSync(recordIndexFile, "utf8"));
    assert.equal(recordIndex.mode, "staging-launch-duty-record-index");
    assert.equal(recordIndex.status, "in_progress");
    assert.equal(recordIndex.recordedCount, 1);
    assert.equal(recordIndex.pendingCount, 5);
    assert.deepEqual(recordIndex.recordedKeys, ["launch_day_watch_summary"]);
    assert.deepEqual(recordIndex.pendingKeys, [
      "receipt_visibility_snapshot",
      "first_wave_incident_log",
      "rollback_signal_review",
      "stabilization_owner_handoff",
      "first_wave_closeout"
    ]);
    assert.equal(recordIndex.updatedRecordKey, "launch_day_watch_summary");
    assert.equal(recordIndex.nextRecordKey, "receipt_visibility_snapshot");
    assert.match(recordIndex.nextRecordCommand, /--record-index-file .*launch-duty-record-index\.json/);
    assert.equal(recordIndex.records.launch_day_watch_summary.status, "recorded");
    assert.equal(recordIndex.records.launch_day_watch_summary.artifactPath, artifactPath);
    assert.deepEqual(recordIndex.records.launch_day_watch_summary.receiptIds, ["receipt-cutover-001", "receipt-readiness-001"]);
    assert.equal(recordIndex.records.launch_day_watch_summary.value.summary, "redacted cutover watch");
    assert.doesNotMatch(JSON.stringify(recordIndex), /Bearer|password|StrongAdmin|StrongDeveloper/i);

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "written");
    assert.equal(output.mode, "staging-launch-duty-record");
    assert.equal(output.key, "launch_day_watch_summary");
    assert.equal(output.actionKey, "record_launch_day_watch_summary");
    assert.equal(output.artifactPath, artifactPath);
    assert.deepEqual(output.receiptOperations, ["record_cutover_walkthrough", "record_launch_day_readiness_review"]);
    assert.deepEqual(output.receiptIds, ["receipt-cutover-001", "receipt-readiness-001"]);
    assert.deepEqual(output.sourceRecords, []);
    assert.deepEqual(output.recordIndex, {
      path: recordIndexFile,
      status: "in_progress",
      recordedCount: 1,
      pendingCount: 5,
      nextRecordKey: "receipt_visibility_snapshot"
    });
    assert.equal(output.nextRecord.key, "receipt_visibility_snapshot");
    assert.match(output.nextRecordCommand, /npm\.cmd run staging:launch-duty:record -- --closeout-input-file .*filled-closeout-input\.json --key receipt_visibility_snapshot --artifact-path .*receipt-visibility-snapshot\.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file .*launch-duty-record-index\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(output.statusCommand, /npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(output.rehearsalReloadCommand, /npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.deepEqual(
      output.operatorNextCommands.map((item) => [item.key, item.status]),
      [
        ["next_launch_duty_record", "current"],
        ["readiness_status", "blocked_after_next_record"],
        ["rehearsal_reload", "blocked_after_readiness_status"]
      ]
    );
    assert.deepEqual(
      output.operatorNextCommands.map((item) => [item.key, item.recordIndexFile]),
      [
        ["next_launch_duty_record", recordIndexFile],
        ["readiness_status", recordIndexFile],
        ["rehearsal_reload", recordIndexFile]
      ]
    );
    assert.deepEqual(output.operatorQueueCheckpoint, {
      mode: "staging-launch-duty-record-operator-queue-checkpoint",
      status: "awaiting_next_launch_duty_record",
      currentActionKey: "next_launch_duty_record",
      currentCommand: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${closeoutInputFile} --key receipt_visibility_snapshot --artifact-path ${launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot")} --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file ${recordIndexFile} --actions-file ${actionsFile}`,
      recordIndexFile,
      closeoutInputFile,
      actionsFile,
      currentArtifactPath: launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot"),
      recordedCount: 1,
      pendingCount: 5,
      nextRecordKey: "receipt_visibility_snapshot",
      nextRecordCommand: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${closeoutInputFile} --key receipt_visibility_snapshot --artifact-path ${launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot")} --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file ${recordIndexFile} --actions-file ${actionsFile}`,
      nextRecordArtifactPath: launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot"),
      completionHandoffStatus: null,
      completionHandoffArtifacts: null,
      completionHandoffNextAction: null,
      operatorCommandCount: 3,
      nextAction: "Run nextRecordCommand for receipt_visibility_snapshot, then refresh readiness status."
    });
    assert.deepEqual(
      {
        version: output.launchEvidenceReadinessGate?.version,
        status: output.launchEvidenceReadinessGate?.status,
        currentGate: output.launchEvidenceReadinessGate?.currentGate,
        currentEvidenceKey: output.launchEvidenceReadinessGate?.currentEvidenceKey,
        currentEvidenceType: output.launchEvidenceReadinessGate?.currentEvidenceType,
        currentEvidenceStatus: output.launchEvidenceReadinessGate?.currentEvidenceStatus,
        currentLaunchDutyRecordKey: output.launchEvidenceReadinessGate?.currentLaunchDutyRecordKey,
        currentCommand: output.launchEvidenceReadinessGate?.currentCommand,
        currentArtifactPath: output.launchEvidenceReadinessGate?.currentArtifactPath,
        completedEvidenceCount: output.launchEvidenceReadinessGate?.completedEvidenceCount,
        pendingEvidenceCount: output.launchEvidenceReadinessGate?.pendingEvidenceCount,
        progress: output.launchEvidenceReadinessGate?.progress,
        launchDutyRecordProgress: output.launchEvidenceReadinessGate?.launchDutyRecordProgress,
        launchDutyRecordIndexPath: output.launchEvidenceReadinessGate?.launchDutyRecordIndexPath
      },
      {
        version: "staging-launch-duty-record-launch-evidence-gate/v1",
        status: "blocked_until_real_launch_evidence_attached",
        currentGate: "launch_duty_record",
        currentEvidenceKey: "first_wave_closeout",
        currentEvidenceType: "launch_duty_record",
        currentEvidenceStatus: "blocked_until_source_records",
        currentLaunchDutyRecordKey: "receipt_visibility_snapshot",
        currentCommand: output.nextRecordCommand,
        currentArtifactPath: launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot"),
        completedEvidenceCount: 20,
        pendingEvidenceCount: 1,
        progress: {
          closeout: { completed: 7, total: 7 },
          productionSignoff: { completed: 7, total: 7 },
          receiptVisibility: { completed: 5, total: 5 },
          launchDuty: { completed: 1, total: 2 }
        },
        launchDutyRecordProgress: {
          recorded: 1,
          pending: 5,
          total: 6,
          nextRecordKey: "receipt_visibility_snapshot"
        },
        launchDutyRecordIndexPath: recordIndexFile
      }
    );
    assert.equal(output.launchEvidenceReadinessGate.evidenceCount, 21);
    assert.equal(evidenceItemByKey(output.launchEvidenceReadinessGate, "launch_day_watch_summary").status, "recorded");
    assert.equal(evidenceItemByKey(output.launchEvidenceReadinessGate, "launch_day_watch_summary").artifactPath, artifactPath);
    assert.equal(evidenceItemByKey(output.launchEvidenceReadinessGate, "first_wave_closeout").status, "blocked_until_source_records");
    const bridge = output.postLaunchDayWatchFirstWaveBridge;
    assert.deepEqual(
      {
        version: bridge?.version,
        status: bridge?.status,
        currentGate: bridge?.currentGate,
        completedRecordKey: bridge?.completedRecordKey,
        recordIndexFile: bridge?.recordIndexFile,
        progress: bridge?.progress,
        currentRecord: bridge?.currentRecord
          ? {
            key: bridge.currentRecord.key,
            status: bridge.currentRecord.status,
            artifactPath: bridge.currentRecord.artifactPath,
            command: bridge.currentRecord.command
          }
          : null,
        stableOperationsHandoff: bridge?.stableOperationsHandoff
      },
      {
        version: "staging-launch-duty-record-post-launch-day-watch-first-wave-bridge/v1",
        status: "ready_for_first_wave_record_queue",
        currentGate: "first_wave_closeout",
        completedRecordKey: "launch_day_watch_summary",
        recordIndexFile,
        progress: {
          recordedCount: 1,
          pendingCount: 5,
          recordedKeys: ["launch_day_watch_summary"],
          pendingKeys: [
            "receipt_visibility_snapshot",
            "first_wave_incident_log",
            "rollback_signal_review",
            "stabilization_owner_handoff",
            "first_wave_closeout"
          ],
          nextRecordKey: "receipt_visibility_snapshot"
        },
        currentRecord: {
          key: "receipt_visibility_snapshot",
          status: "current",
          artifactPath: launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot"),
          command: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${closeoutInputFile} --key receipt_visibility_snapshot --artifact-path ${launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot")} --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file ${recordIndexFile} --actions-file ${actionsFile}`
        },
        stableOperationsHandoff: {
          status: "blocked_until_first_wave_closeout",
          requiredArtifacts: [recordIndexFile, launchDutyArtifactPath(artifactRoot, "first_wave_closeout")],
          nextAction: "Finish the first-wave record queue, refresh readiness status, reload rehearsal, then continue stable-operations handoff."
        }
      }
    );
    assert.deepEqual(
      bridge.remainingRecordQueue.map((item) => [item.key, item.status, item.artifactPath]),
      [
        ["receipt_visibility_snapshot", "current", launchDutyArtifactPath(artifactRoot, "receipt_visibility_snapshot")],
        ["first_wave_incident_log", "blocked_after_receipt_visibility_snapshot", launchDutyArtifactPath(artifactRoot, "first_wave_incident_log")],
        ["rollback_signal_review", "blocked_after_first_wave_incident_log", launchDutyArtifactPath(artifactRoot, "rollback_signal_review")],
        ["stabilization_owner_handoff", "blocked_after_rollback_signal_review", launchDutyArtifactPath(artifactRoot, "stabilization_owner_handoff")],
        ["first_wave_closeout", "blocked_until_source_records", launchDutyArtifactPath(artifactRoot, "first_wave_closeout")]
      ]
    );
    const closeoutQueueItem = bridge.remainingRecordQueue.find((item) => item.key === "first_wave_closeout");
    assert.match(closeoutQueueItem.command, /--source-record first_wave_incident_log=.*first-wave-incident-log\.md/);
    assert.match(closeoutQueueItem.command, /--source-record rollback_signal_review=.*rollback-signal-review\.md/);
    assert.match(closeoutQueueItem.command, /--source-record stabilization_owner_handoff=.*stabilization-owner-handoff\.md/);
    assert.deepEqual(closeoutQueueItem.sourceRecordKeys, [
      "first_wave_incident_log",
      "rollback_signal_review",
      "stabilization_owner_handoff"
    ]);
    assert.equal(bridge.statusCommand, `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`);
    assert.equal(bridge.rehearsalReloadCommand, `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`);
    assert.deepEqual(output.productionSwitchProofPacket, buildExpectedProductionSwitchProofPacket({
      closeoutInputFile,
      actionsFile,
      archiveRoot: artifactRoot,
      currentActionKey: "record_next_launch_duty_record",
      currentCommand: output.nextRecordCommand,
      launchDutyStatus: "blocked_after_production_signoff_readiness",
      launchDutyArtifactPath: artifactPath
    }));
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record prints first-wave queue bridge after launch-day watch summary", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-watch-bridge-plain-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(artifactRoot, "filled-closeout-input.json");
    const actionsFile = join(artifactRoot, "readiness-action-queue.md");
    const artifactPath = launchDutyArtifactPath(artifactRoot, "launch_day_watch_summary");
    const recordIndexFile = join(artifactRoot, "launch-duty-record-index.json");

    const result = runRecordPlain([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "launch_day_watch_summary",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"recorded\",\"summary\":\"redacted cutover watch\"}",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Post-launch-day watch bridge: ready_for_first_wave_record_queue \| recorded=1\/6 \| pending=5 \| next=receipt_visibility_snapshot/);
    assert.match(result.stdout, /Post-launch-day current: receipt_visibility_snapshot -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file .*filled-closeout-input\.json --key receipt_visibility_snapshot --artifact-path .*receipt-visibility-snapshot\.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file .*launch-duty-record-index\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-launch-day queue 5\. first_wave_closeout: blocked_until_source_records -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file .*filled-closeout-input\.json --key first_wave_closeout --artifact-path .*first-wave-closeout\.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=.*first-wave-incident-log\.md --source-record rollback_signal_review=.*rollback-signal-review\.md --source-record stabilization_owner_handoff=.*stabilization-owner-handoff\.md --record-index-file .*launch-duty-record-index\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-launch-day stable handoff: blocked_until_first_wave_closeout -> .*launch-duty-record-index\.json; .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Post-launch-day readiness: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-launch-day rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record marks bound non-default secret env ready when required env vars are present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-secret-env-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(artifactRoot, "filled-closeout-input.json");
    const actionsFile = join(artifactRoot, "readiness-action-queue.md");
    const artifactPath = join(artifactRoot, "launch-day-watch-summary.md");
    const recordIndexFile = join(artifactRoot, "launch-duty-record-index.json");
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(closeoutInputFile, `${JSON.stringify({
      mode: "staging-closeout-template",
      baseUrl: "https://staging.example.com",
      storageProfile: "postgres-preview",
      stagingEnvironmentBinding: {
        environment: {
          targetEnvFile: "/etc/rocksolidlicense/staging.env"
        },
        credentialEnv: {
          adminPassword: "RSL_SMOKE_ADMIN_PASSWORD",
          developerPassword: "RSL_SMOKE_DEVELOPER_PASSWORD",
          developerBearerToken: "RSL_DEVELOPER_BEARER_TOKEN"
        }
      }
    }, null, 2)}\n`, "utf8");

    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "launch_day_watch_summary",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"recorded\",\"summary\":\"redacted cutover watch\"}",
      "--record-index-file",
      recordIndexFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "RealAdminSecret123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "RealDeveloperSecret123!",
      RSL_DEVELOPER_BEARER_TOKEN: "real-bearer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.productionSwitchProofPacket.proofItems.slice(0, 3).map((item) => [item.key, item.status, item.artifactPath]),
      [
        ["public_https_entrypoint", "ready_from_closeout_input", "https://staging.example.com"],
        ["non_default_secret_env", "ready_secret_env_loaded", "/etc/rocksolidlicense/staging.env"],
        ["storage_profile_selected", "ready_from_closeout_input", "postgres-preview"]
      ]
    );
    assert.deepEqual(output.productionSwitchProofPacket.secretEnvProof, {
      status: "ready_secret_env_loaded",
      requiredKeys: [
        "RSL_SMOKE_ADMIN_PASSWORD",
        "RSL_SMOKE_DEVELOPER_PASSWORD",
        "RSL_DEVELOPER_BEARER_TOKEN"
      ],
      presentKeys: [
        "RSL_SMOKE_ADMIN_PASSWORD",
        "RSL_SMOKE_DEVELOPER_PASSWORD",
        "RSL_DEVELOPER_BEARER_TOKEN"
      ],
      missingKeys: [],
      requiredCount: 3,
      missingCount: 0,
      currentMissingKey: null,
      targetEnvFile: "/etc/rocksolidlicense/staging.env",
      currentActionKey: "confirm_secret_env_loaded",
      nextAction: "Required secret environment variables are loaded; continue production switch proof."
    });
    assert.deepEqual(output.productionSwitchProofPacket.proofCounts, {
      total: 8,
      ready: 7,
      blocked: 1
    });
    assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record prints secret env proof in plain output without secret values", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-secret-env-plain-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(artifactRoot, "filled-closeout-input.json");
    const actionsFile = join(artifactRoot, "readiness-action-queue.md");
    const artifactPath = join(artifactRoot, "launch-day-watch-summary.md");
    const recordIndexFile = join(artifactRoot, "launch-duty-record-index.json");
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(closeoutInputFile, `${JSON.stringify({
      mode: "staging-closeout-template",
      stagingEnvironmentBinding: {
        environment: {
          targetEnvFile: "/etc/rocksolidlicense/staging.env"
        },
        credentialEnv: {
          adminPassword: "RSL_SMOKE_ADMIN_PASSWORD",
          developerPassword: "RSL_SMOKE_DEVELOPER_PASSWORD",
          developerBearerToken: "RSL_DEVELOPER_BEARER_TOKEN"
        }
      }
    }, null, 2)}\n`, "utf8");

    const result = runRecordPlain([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "launch_day_watch_summary",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"recorded\",\"summary\":\"redacted cutover watch\"}",
      "--record-index-file",
      recordIndexFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "RealAdminSecret123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "RealDeveloperSecret123!",
      RSL_DEVELOPER_BEARER_TOKEN: ""
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Production switch backup\/restore proof: ready_evidence_attached \(key=backup_restore_drill_result, artifact=[^\n]*backup_restore_drill_result\.txt, receipts=-\)/);
    assert.match(result.stdout, /Production switch secret env proof: pending_real_environment_confirmation \(required=3, missing=1, current=RSL_DEVELOPER_BEARER_TOKEN\)/);
    assert.match(result.stdout, /Production switch secret env required: RSL_SMOKE_ADMIN_PASSWORD, RSL_SMOKE_DEVELOPER_PASSWORD, RSL_DEVELOPER_BEARER_TOKEN/);
    assert.match(result.stdout, /Production switch secret env missing: RSL_DEVELOPER_BEARER_TOKEN/);
    assert.doesNotMatch(result.stdout, /RealAdminSecret123!|RealDeveloperSecret123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record appends subsequent artifacts to the same index", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-index-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const recordIndexFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-duty-record-index.json");
    const watchArtifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-day-watch-summary.md");
    const receiptArtifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "receipt-visibility-snapshot.txt");

    const watchResult = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--key",
      "launch_day_watch_summary",
      "--artifact-path",
      watchArtifactPath,
      "--value-json",
      "{\"result\":\"recorded\",\"summary\":\"redacted cutover watch\"}",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(watchResult.status, 0, watchResult.stderr || watchResult.stdout);

    const receiptResult = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--key",
      "receipt_visibility_snapshot",
      "--artifact-path",
      receiptArtifactPath,
      "--value-json",
      "{\"result\":\"visible\",\"summary\":\"redacted receipt snapshot\"}",
      "--receipt-id",
      "receipt-ops-001",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(receiptResult.status, 0, receiptResult.stderr || receiptResult.stdout);
    const output = JSON.parse(receiptResult.stdout);
    assert.deepEqual(output.recordIndex, {
      path: recordIndexFile,
      status: "in_progress",
      recordedCount: 2,
      pendingCount: 4,
      nextRecordKey: "first_wave_incident_log"
    });

    const recordIndex = JSON.parse(readFileSync(recordIndexFile, "utf8"));
    assert.equal(recordIndex.status, "in_progress");
    assert.deepEqual(recordIndex.recordedKeys, ["launch_day_watch_summary", "receipt_visibility_snapshot"]);
    assert.deepEqual(recordIndex.pendingKeys, [
      "first_wave_incident_log",
      "rollback_signal_review",
      "stabilization_owner_handoff",
      "first_wave_closeout"
    ]);
    assert.equal(recordIndex.records.receipt_visibility_snapshot.artifactPath, receiptArtifactPath);
    assert.deepEqual(recordIndex.records.receipt_visibility_snapshot.receiptIds, ["receipt-ops-001"]);
    assert.match(recordIndex.nextRecordCommand, /--key first_wave_incident_log/);
    assert.match(recordIndex.nextRecordCommand, /--record-index-file .*launch-duty-record-index\.json/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record carries indexed source records into first-wave closeout command", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-index-sources-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const recordIndexFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-duty-record-index.json");
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const records = [
      ["launch_day_watch_summary", join(artifactRoot, "launch-day-watch-summary.md")],
      ["receipt_visibility_snapshot", join(artifactRoot, "receipt-visibility-snapshot.txt")],
      ["first_wave_incident_log", join(artifactRoot, "first-wave-incident-log.md")],
      ["rollback_signal_review", join(artifactRoot, "rollback-signal-review.md")],
      ["stabilization_owner_handoff", join(artifactRoot, "stabilization-owner-handoff.md")]
    ];
    let latestOutput = null;

    for (const [key, artifactPath] of records) {
      const result = runRecord([
        "--closeout-input-file",
        closeoutInputFile,
        "--key",
        key,
        "--artifact-path",
        artifactPath,
        "--value-json",
        `{"result":"recorded","summary":"redacted ${key}"}`,
        "--record-index-file",
        recordIndexFile
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      latestOutput = JSON.parse(result.stdout);
    }

    assert.equal(latestOutput.nextRecord.key, "first_wave_closeout");
    assert.match(latestOutput.nextRecordCommand, /--key first_wave_closeout/);
    assert.match(latestOutput.nextRecordCommand, /--source-record first_wave_incident_log=.*first-wave-incident-log\.md/);
    assert.match(latestOutput.nextRecordCommand, /--source-record rollback_signal_review=.*rollback-signal-review\.md/);
    assert.match(latestOutput.nextRecordCommand, /--source-record stabilization_owner_handoff=.*stabilization-owner-handoff\.md/);
    assert.doesNotMatch(latestOutput.nextRecordCommand, /<first_wave_incident_log-artifact-path>|<rollback_signal_review-artifact-path>|<stabilization_owner_handoff-artifact-path>/);

    const recordIndex = JSON.parse(readFileSync(recordIndexFile, "utf8"));
    assert.equal(recordIndex.nextRecordKey, "first_wave_closeout");
    assert.match(recordIndex.nextRecordCommand, /--source-record first_wave_incident_log=.*first-wave-incident-log\.md/);
    assert.match(recordIndex.nextRecordCommand, /--source-record rollback_signal_review=.*rollback-signal-review\.md/);
    assert.match(recordIndex.nextRecordCommand, /--source-record stabilization_owner_handoff=.*stabilization-owner-handoff\.md/);
    assert.doesNotMatch(recordIndex.nextRecordCommand, /<first_wave_incident_log-artifact-path>|<rollback_signal_review-artifact-path>|<stabilization_owner_handoff-artifact-path>/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record auto-fills first-wave closeout source records from index", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-closeout-autosource-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const recordIndexFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-duty-record-index.json");
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const incidentPath = join(artifactRoot, "first-wave-incident-log.md");
    const rollbackPath = join(artifactRoot, "rollback-signal-review.md");
    const handoffPath = join(artifactRoot, "stabilization-owner-handoff.md");

    for (const [key, artifactPath] of [
      ["first_wave_incident_log", incidentPath],
      ["rollback_signal_review", rollbackPath],
      ["stabilization_owner_handoff", handoffPath]
    ]) {
      const result = runRecord([
        "--closeout-input-file",
        closeoutInputFile,
        "--key",
        key,
        "--artifact-path",
        artifactPath,
        "--value-json",
        `{"result":"recorded","summary":"redacted ${key}"}`,
        "--record-index-file",
        recordIndexFile
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const closeoutArtifactPath = join(artifactRoot, "first-wave-closeout.md");
    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--key",
      "first_wave_closeout",
      "--artifact-path",
      closeoutArtifactPath,
      "--value-json",
      "{\"result\":\"closed\",\"summary\":\"redacted closeout\"}",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.sourceRecords, [
      { key: "first_wave_incident_log", path: incidentPath },
      { key: "rollback_signal_review", path: rollbackPath },
      { key: "stabilization_owner_handoff", path: handoffPath }
    ]);

    const artifact = readFileSync(closeoutArtifactPath, "utf8");
    assert.match(artifact, /Source records: `first_wave_incident_log=.*first-wave-incident-log\.md; rollback_signal_review=.*rollback-signal-review\.md; stabilization_owner_handoff=.*stabilization-owner-handoff\.md`/);

    const recordIndex = JSON.parse(readFileSync(recordIndexFile, "utf8"));
    assert.deepEqual(recordIndex.records.first_wave_closeout.sourceRecords, output.sourceRecords);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record emits completion handoff after first-wave closeout completes the index", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-complete-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(artifactRoot, "filled-closeout-input.json");
    const actionsFile = join(artifactRoot, "readiness-action-queue.md");
    const recordIndexFile = join(artifactRoot, "launch-duty-record-index.json");
    const closeoutArtifactPath = launchDutyArtifactPath(artifactRoot, "first_wave_closeout");
    recordLaunchDutySequence({
      closeoutInputFile,
      actionsFile,
      recordIndexFile,
      artifactRoot,
      keys: [
        "launch_day_watch_summary",
        "receipt_visibility_snapshot",
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ]
    });

    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "first_wave_closeout",
      "--artifact-path",
      closeoutArtifactPath,
      "--value-json",
      "{\"result\":\"closed\",\"summary\":\"redacted closeout\"}",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.operatorQueueCheckpoint, {
      mode: "staging-launch-duty-record-operator-queue-checkpoint",
      status: "ready_for_stabilization_handoff",
      currentActionKey: "readiness_status",
      currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      recordIndexFile,
      closeoutInputFile,
      actionsFile,
      currentArtifactPath: actionsFile,
      recordedCount: 6,
      pendingCount: 0,
      nextRecordKey: null,
      nextRecordCommand: null,
      nextRecordArtifactPath: null,
      completionHandoffStatus: "ready_for_stabilization_handoff",
      completionHandoffArtifacts: [recordIndexFile, closeoutArtifactPath],
      completionHandoffNextAction: "Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner.",
      operatorCommandCount: 3,
      nextAction: "Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner."
    });
    assert.deepEqual(output.recordIndex, {
      path: recordIndexFile,
      status: "complete",
      recordedCount: 6,
      pendingCount: 0,
      nextRecordKey: null
    });
    assert.equal(output.nextRecord, null);
    assert.equal(output.nextRecordCommand, null);
    assert.deepEqual(output.completionHandoff, {
      status: "ready_for_stabilization_handoff",
      completedAt: output.recordedAt,
      closeoutInputFile,
      actionsFile,
      recordIndexFile,
      recordedCount: 6,
      pendingCount: 0,
      completedRecordKeys: [
        "launch_day_watch_summary",
        "receipt_visibility_snapshot",
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff",
        "first_wave_closeout"
      ],
      firstWaveCloseoutArtifactPath: closeoutArtifactPath,
      sourceRecords: [
        { key: "first_wave_incident_log", path: launchDutyArtifactPath(artifactRoot, "first_wave_incident_log") },
        { key: "rollback_signal_review", path: launchDutyArtifactPath(artifactRoot, "rollback_signal_review") },
        { key: "stabilization_owner_handoff", path: launchDutyArtifactPath(artifactRoot, "stabilization_owner_handoff") }
      ],
      handoffArtifacts: [recordIndexFile, closeoutArtifactPath],
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      rehearsalReloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      nextAction: "Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner."
    });
    assert.deepEqual(
      {
        version: output.launchEvidenceReadinessGate?.version,
        status: output.launchEvidenceReadinessGate?.status,
        currentGate: output.launchEvidenceReadinessGate?.currentGate,
        currentEvidenceKey: output.launchEvidenceReadinessGate?.currentEvidenceKey,
        currentEvidenceType: output.launchEvidenceReadinessGate?.currentEvidenceType,
        currentEvidenceStatus: output.launchEvidenceReadinessGate?.currentEvidenceStatus,
        currentLaunchDutyRecordKey: output.launchEvidenceReadinessGate?.currentLaunchDutyRecordKey,
        currentCommand: output.launchEvidenceReadinessGate?.currentCommand,
        currentArtifactPath: output.launchEvidenceReadinessGate?.currentArtifactPath,
        completedEvidenceCount: output.launchEvidenceReadinessGate?.completedEvidenceCount,
        pendingEvidenceCount: output.launchEvidenceReadinessGate?.pendingEvidenceCount,
        progress: output.launchEvidenceReadinessGate?.progress,
        launchDutyRecordProgress: output.launchEvidenceReadinessGate?.launchDutyRecordProgress,
        stableOperationsHandoff: output.launchEvidenceReadinessGate?.stableOperationsHandoff
      },
      {
        version: "staging-launch-duty-record-launch-evidence-gate/v1",
        status: "ready_for_stabilization_handoff",
        currentGate: "launch_duty_record",
        currentEvidenceKey: "first_wave_closeout",
        currentEvidenceType: "launch_duty_record",
        currentEvidenceStatus: "recorded",
        currentLaunchDutyRecordKey: null,
        currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        currentArtifactPath: closeoutArtifactPath,
        completedEvidenceCount: 21,
        pendingEvidenceCount: 0,
        progress: {
          closeout: { completed: 7, total: 7 },
          productionSignoff: { completed: 7, total: 7 },
          receiptVisibility: { completed: 5, total: 5 },
          launchDuty: { completed: 2, total: 2 }
        },
        launchDutyRecordProgress: {
          recorded: 6,
          pending: 0,
          total: 6,
          nextRecordKey: null
        },
        stableOperationsHandoff: {
          status: "ready_for_stabilization_handoff",
          handoffArtifacts: [recordIndexFile, closeoutArtifactPath],
          nextAction: "Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner."
        }
      }
    );
    assert.equal(evidenceItemByKey(output.launchEvidenceReadinessGate, "first_wave_closeout").status, "recorded");
    assert.equal(evidenceItemByKey(output.launchEvidenceReadinessGate, "first_wave_closeout").artifactPath, closeoutArtifactPath);
    assert.deepEqual(output.productionSwitchProofPacket, buildExpectedProductionSwitchProofPacket({
      closeoutInputFile,
      actionsFile,
      archiveRoot: artifactRoot,
      currentActionKey: "refresh_readiness_status",
      currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      launchDutyStatus: "ready_evidence_attached",
      launchDutyArtifactPath: closeoutArtifactPath
    }));
    assert.deepEqual(
      output.operatorNextCommands.map((item) => [item.key, item.status]),
      [
        ["readiness_status", "current"],
        ["rehearsal_reload", "blocked_after_readiness_status"],
        ["stable_operations_handoff", "blocked_after_rehearsal_reload"]
      ]
    );
    const handoffStep = output.operatorNextCommands.find((item) => item.key === "stable_operations_handoff");
    assert.equal(handoffStep.command, null);
    assert.deepEqual(handoffStep.handoffArtifacts, [recordIndexFile, closeoutArtifactPath]);

    const recordIndex = JSON.parse(readFileSync(recordIndexFile, "utf8"));
    assert.deepEqual(recordIndex.completionHandoff, output.completionHandoff);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record prints completion handoff after first-wave closeout completes the index", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-complete-plain-"));
  try {
    const artifactRoot = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable");
    const closeoutInputFile = join(artifactRoot, "filled-closeout-input.json");
    const actionsFile = join(artifactRoot, "readiness-action-queue.md");
    const recordIndexFile = join(artifactRoot, "launch-duty-record-index.json");
    const closeoutArtifactPath = launchDutyArtifactPath(artifactRoot, "first_wave_closeout");
    recordLaunchDutySequence({
      closeoutInputFile,
      actionsFile,
      recordIndexFile,
      artifactRoot,
      keys: [
        "launch_day_watch_summary",
        "receipt_visibility_snapshot",
        "first_wave_incident_log",
        "rollback_signal_review",
        "stabilization_owner_handoff"
      ]
    });

    const result = runRecordPlain([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "first_wave_closeout",
      "--artifact-path",
      closeoutArtifactPath,
      "--value-json",
      "{\"result\":\"closed\",\"summary\":\"redacted closeout\"}",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Launch duty record index status: complete/);
    assert.match(result.stdout, /Launch duty record index progress: 6\/6 recorded, 0 pending/);
    assert.match(result.stdout, /Launch duty operator checkpoint: readiness_status \(status=ready_for_stabilization_handoff, commands=3\)/);
    assert.match(result.stdout, /Launch duty checkpoint current: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch duty checkpoint record index: .*launch-duty-record-index\.json/);
    assert.match(result.stdout, /Launch duty checkpoint progress: 6\/6 recorded, 0 pending/);
    assert.match(result.stdout, /Launch duty checkpoint next record: none/);
    assert.match(result.stdout, /Launch duty checkpoint completion handoff: ready_for_stabilization_handoff/);
    assert.match(result.stdout, /Launch duty checkpoint handoff artifacts: .*launch-duty-record-index\.json; .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch duty checkpoint handoff next action: Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner\./);
    assert.match(result.stdout, /Launch evidence gate: ready_for_stabilization_handoff \(current=first_wave_closeout, pending=0\/21\)/);
    assert.match(result.stdout, /Launch evidence current: launch_duty_record\/first_wave_closeout -> npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence progress: closeout=7\/7, signoff=7\/7, receipts=5\/5, launchDuty=2\/2/);
    assert.match(result.stdout, /Launch evidence launch-duty records: 6\/6 recorded, 0 pending, next=-/);
    assert.match(result.stdout, /Launch evidence stable handoff: ready_for_stabilization_handoff -> .*launch-duty-record-index\.json; .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Production switch proof packet: blocked_until_real_environment_evidence \(ready=5\/8, blocked=3\/8, current=refresh_readiness_status\)/);
    assert.match(result.stdout, /Production switch proof 8\. launch_day_watch_and_stabilization: ready_evidence_attached -> .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Production switch next action: Continue the current launch-duty command, rerun staging:readiness:status, then use this packet as the production switch proof checklist\./);
    assert.match(result.stdout, /Launch duty completion handoff: ready_for_stabilization_handoff/);
    assert.match(result.stdout, /Launch duty completion handoff artifacts: .*launch-duty-record-index\.json; .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch duty completion handoff next action: Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner\./);
    assert.match(result.stdout, /Launch duty operator next blocked_after_rehearsal_reload: stable_operations_handoff -> -/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record writes first-wave closeout with source records in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-closeout-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    const artifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "first-wave-closeout.md");

    const result = runRecordPlain([
      "--closeout-input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "first_wave_closeout",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"closed\",\"unresolvedIncidents\":[],\"summary\":\"redacted closeout\"}",
      "--receipt-id",
      "receipt-closeout-001",
      "--source-record",
      "first_wave_incident_log=artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md",
      "--source-record",
      "rollback_signal_review=artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md",
      "--source-record",
      "stabilization_owner_handoff=artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(artifactPath), true);
    const artifact = readFileSync(artifactPath, "utf8");
    assert.match(artifact, /Key: `first_wave_closeout`/);
    assert.match(artifact, /Source records: `first_wave_incident_log=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md`/);
    assert.match(result.stdout, /Launch duty record written: first_wave_closeout/);
    assert.match(result.stdout, /Launch duty record action: close_first_wave/);
    assert.match(result.stdout, /Launch duty record artifact: .*first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch duty record receipts: receipt-closeout-001/);
    assert.match(result.stdout, /Launch duty record source records: first_wave_incident_log=artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-incident-log\.md; rollback_signal_review=artifacts\/staging\/PILOT_ALPHA\/stable\/rollback-signal-review\.md; stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(result.stdout, /Launch duty record index: .*launch-duty-record-index\.json/);
    assert.match(result.stdout, /Launch duty record index status: in_progress/);
    assert.match(result.stdout, /Launch duty record index progress: 1\/6 recorded, 5 pending/);
    assert.match(result.stdout, /Launch duty record index next key: launch_day_watch_summary/);
    assert.match(result.stdout, /Launch duty record next command: -/);
    assert.match(result.stdout, /Launch duty record status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch duty record rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Launch duty operator next current: readiness_status -> npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch duty operator next current record index: .*launch-duty-record-index\.json/);
    assert.match(result.stdout, /Launch duty operator next blocked_after_readiness_status: rehearsal_reload -> npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Launch duty operator next blocked_after_readiness_status record index: .*launch-duty-record-index\.json/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record refuses first-wave closeout without required source records", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-missing-sources-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const artifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "first-wave-closeout.md");
    const recordIndexFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-duty-record-index.json");

    const result = runRecord([
      "--closeout-input-file",
      closeoutInputFile,
      "--key",
      "first_wave_closeout",
      "--artifact-path",
      artifactPath,
      "--value-json",
      "{\"result\":\"closed\",\"summary\":\"redacted closeout\"}",
      "--source-record",
      "first_wave_incident_log=artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md",
      "--record-index-file",
      recordIndexFile
    ]);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /Missing required source records for first_wave_closeout: rollback_signal_review, stabilization_owner_handoff/);
    assert.equal(existsSync(artifactPath), false);
    assert.equal(existsSync(recordIndexFile), false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging launch duty record refuses unknown keys", () => {
  const result = runRecord([
    "--closeout-input-file",
    "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    "--key",
    "unknown_launch_record",
    "--artifact-path",
    "artifacts/staging/PILOT_ALPHA/stable/unknown.md",
    "--value-json",
    "{\"result\":\"recorded\"}"
  ]);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.match(output.error.message, /Unknown launch duty record key: unknown_launch_record/);
});
