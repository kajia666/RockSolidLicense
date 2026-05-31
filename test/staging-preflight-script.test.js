import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runPreflight(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-preflight.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 60_000
  });
}

function runPlainPreflight(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-preflight.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 60_000
  });
}

test("staging preflight is exposed as an npm script and blocks plain-http staging URLs", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:preflight"], "node scripts/staging-preflight.mjs");

  const result = runPreflight([
    "--base-url",
    "http://staging.example.com",
    "--product-code",
    "PILOT_ALPHA",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.equal(output.mode, "staging-preflight");
  assert.match(output.error.message, /requires https:\/\/ staging base URL/);
  assert.equal(output.summary.willWriteLiveData, false);
  assert.equal(output.checks.find((item) => item.name === "base-url.https")?.status, "fail");
});

test("staging preflight returns a redacted launch smoke staging command for valid inputs", () => {
  const result = runPreflight([
    "--base-url",
    "https://staging.example.com/",
    "--product-code",
    "PILOT_ALPHA",
    "--channel",
    "beta",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "staging-preflight");
  assert.equal(output.summary.baseUrl, "https://staging.example.com");
  assert.equal(output.summary.productCode, "PILOT_ALPHA");
  assert.equal(output.summary.channel, "beta");
  assert.equal(output.summary.willWriteLiveData, false);
  assert.ok(output.checks.every((item) => item.status === "pass"));
  assert.match(output.nextCommand.powershell, /launch:smoke:staging/);
  assert.match(output.nextCommand.powershell, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
  assert.match(output.nextCommand.powershell, /\$env:RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.doesNotMatch(output.nextCommand.powershell, /StrongAdmin123!/);
  assert.doesNotMatch(output.nextCommand.powershell, /StrongDeveloper123!/);
  assert.equal(output.nextCommand.willWriteLiveData, true);
});

test("staging preflight emits a live-write smoke handoff with post-smoke evidence expectations", () => {
  const result = runPreflight([
    "--base-url",
    "https://staging.example.com/",
    "--product-code",
    "PILOT_ALPHA",
    "--channel",
    "beta",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.liveWriteSmokeHandoff.mode, "staging-preflight-live-write-smoke-handoff/v1");
  assert.equal(output.liveWriteSmokeHandoff.status, "ready_for_manual_live_write_smoke");
  assert.equal(output.liveWriteSmokeHandoff.currentActionKey, "launch_smoke_staging");
  assert.equal(output.liveWriteSmokeHandoff.currentCommand, output.nextCommand.powershell);
  assert.equal(output.liveWriteSmokeHandoff.closeoutInputFile, "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json");
  assert.equal(output.liveWriteSmokeHandoff.readinessActionQueueFile, "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md");
  assert.equal(
    output.liveWriteSmokeHandoff.readinessStatusCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
  );
  assert.deepEqual(output.liveWriteSmokeHandoff.requiredSecretEnv, [
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_PASSWORD"
  ]);
  assert.deepEqual(
    output.liveWriteSmokeHandoff.expectedPostSmokeBackfillKeys,
    [
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review"
    ]
  );
  assert.deepEqual(output.liveWriteSmokeHandoff.manualLiveWriteGate, {
    key: "launch_smoke_staging",
    status: "operator_confirmation_required",
    requiresOperatorConfirmation: true,
    willWriteLiveData: true,
    willModifyData: true
  });
  assert.match(output.nextCommand.powershell, /--closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json/);
  assert.match(output.nextCommand.powershell, /--actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
});

test("staging preflight plain output prints the live-write smoke handoff", () => {
  const result = runPlainPreflight([
    "--base-url",
    "https://staging.example.com/",
    "--product-code",
    "PILOT_ALPHA",
    "--channel",
    "beta",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Staging live-write smoke handoff: ready_for_manual_live_write_smoke \| current=launch_smoke_staging \| manualGate=launch_smoke_staging/);
  assert.match(result.stdout, /Staging live-write smoke files: closeout=artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json \| actions=artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Staging post-smoke expected backfills: live_write_smoke_result, launch_smoke_handoff, launch_mainline_evidence_receipts, receipt_visibility_review/);
  assert.match(result.stdout, /Staging post-smoke readiness: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
  assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
});
