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
      profileKeyCount: 20,
      secretPolicy: "passwords_and_bearer_tokens_must_stay_in_environment_variables",
      nextCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
      nextAction: "Review the secret-free profile values, set required secret env vars, then run nextCommand."
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
      filledCloseoutDraftFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json"
    });
    assert.doesNotMatch(JSON.stringify(profile), /password|bearer|token/i);
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
