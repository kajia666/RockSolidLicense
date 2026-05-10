import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runRecord(args) {
  return spawnSync(process.execPath, ["scripts/staging-launch-duty-record.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runRecordPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-launch-duty-record.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

test("staging launch duty record writes a watch summary artifact and next command", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:launch-duty:record"], "node scripts/staging-launch-duty-record.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-launch-duty-record-watch-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    const artifactPath = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "launch-day-watch-summary.md");

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
    const artifact = readFileSync(artifactPath, "utf8");
    assert.match(artifact, /^# Staging Launch Duty Record/m);
    assert.match(artifact, /Key: `launch_day_watch_summary`/);
    assert.match(artifact, /Action key: `record_launch_day_watch_summary`/);
    assert.match(artifact, /Receipt IDs: `receipt-cutover-001, receipt-readiness-001`/);
    assert.match(artifact, /"summary": "redacted cutover watch"/);
    assert.doesNotMatch(artifact, /Bearer|password|StrongAdmin|StrongDeveloper/i);

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "written");
    assert.equal(output.mode, "staging-launch-duty-record");
    assert.equal(output.key, "launch_day_watch_summary");
    assert.equal(output.actionKey, "record_launch_day_watch_summary");
    assert.equal(output.artifactPath, artifactPath);
    assert.deepEqual(output.receiptOperations, ["record_cutover_walkthrough", "record_launch_day_readiness_review"]);
    assert.deepEqual(output.receiptIds, ["receipt-cutover-001", "receipt-readiness-001"]);
    assert.deepEqual(output.sourceRecords, []);
    assert.equal(output.nextRecord.key, "receipt_visibility_snapshot");
    assert.match(output.nextRecordCommand, /npm\.cmd run staging:launch-duty:record -- --closeout-input-file .*filled-closeout-input\.json --key receipt_visibility_snapshot --artifact-path .*receipt-visibility-snapshot\.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file .*readiness-action-queue\.md/);
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
    assert.match(result.stdout, /Launch duty record next command: -/);
    assert.match(result.stdout, /Launch duty record status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch duty record rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
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
