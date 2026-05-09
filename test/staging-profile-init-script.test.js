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
      closeoutInitCommand: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      postCloseoutInitStatusCommand: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
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
        }
      ],
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then run closeoutInitCommand after the draft is written."
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
    assert.match(result.stdout, /Current command: npm\.cmd run staging:rehearsal -- --profile-file .*staging-profile\.json/);
    assert.match(result.stdout, /Closeout init: npm\.cmd run staging:closeout:init -- --draft-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Next action: Review the secret-free profile values, set required secret env vars, run nextCommand, then run closeoutInitCommand after the draft is written\./);
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
