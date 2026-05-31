import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");

function runProfileCheck(args) {
  return spawnSync(process.execPath, ["scripts/staging-profile-check.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });
}

test("staging profile check validates the committed real-like example without loading secrets", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:profile:check"], "node scripts/staging-profile-check.mjs");

  const result = runProfileCheck([
    "--profile-file",
    "docs/staging-rehearsal-profile.example.json"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "staging-profile-check");
  assert.equal(output.summary.secretFree, true);
  assert.equal(output.summary.willWriteLiveData, false);
  assert.equal(output.summary.willModifyData, false);
  assert.equal(output.summary.checksFailed, 0);
  assert.equal(
    output.productionProofExecutionPackFile,
    "artifacts/staging/PILOT_ALPHA/stable/production-proof-execution-pack.md"
  );
  assert.equal(
    output.nextCommand,
    "npm.cmd run launch:production-proof-preflight -- --profile-file docs/staging-rehearsal-profile.example.json"
  );
  assert.match(output.nextAction, /set required secret env vars/i);
});

test("staging profile check emits a secret-free operator handoff for the next staging step", () => {
  const result = runProfileCheck([
    "--profile-file",
    "docs/staging-rehearsal-profile.example.json"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.operatorHandoff.mode, "staging-profile-check-operator-handoff/v1");
  assert.equal(output.operatorHandoff.currentCommand, output.nextCommand);
  assert.equal(
    output.operatorHandoff.productionProofExecutionPackFile,
    "artifacts/staging/PILOT_ALPHA/stable/production-proof-execution-pack.md"
  );
  assert.deepEqual(output.operatorHandoff.requiredSecretEnv, [
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_PASSWORD",
    "RSL_DEVELOPER_BEARER_TOKEN"
  ]);
  assert.deepEqual(output.operatorHandoff.noWriteBoundary, {
    productionProofPreflight: "must_pass_before_live_write",
    recoveryPreflight: "must_pass_before_live_write",
    stagingPreflight: "must_pass_before_live_write"
  });
  assert.deepEqual(output.operatorHandoff.manualLiveWriteGate, {
    gateId: "launch_smoke_staging",
    status: "blocked_until_production_proof_and_no_write_preflights_pass"
  });
  assert.match(output.operatorHandoff.nextAction, /run currentCommand/i);
});

test("staging profile check prints the operator handoff in plain output", () => {
  const result = spawnSync(process.execPath, [
    "scripts/staging-profile-check.mjs",
    "--profile-file",
    "docs/staging-rehearsal-profile.example.json"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /Production proof execution pack: artifacts\/staging\/PILOT_ALPHA\/stable\/production-proof-execution-pack\.md/
  );
  assert.match(
    result.stdout,
    /Required secret env: RSL_SMOKE_ADMIN_PASSWORD, RSL_SMOKE_DEVELOPER_PASSWORD, RSL_DEVELOPER_BEARER_TOKEN/
  );
  assert.match(
    result.stdout,
    /Manual live-write gate: launch_smoke_staging is blocked until production proof and no-write preflights pass\./
  );
});

test("staging profile check fails when the execution-pack metadata is missing", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "staging-profile-check-missing-pack-"));
  const profileFile = join(tempRoot, "staging-profile.json");
  try {
    const profile = JSON.parse(
      readFileSync(join(repoRoot, "docs/staging-rehearsal-profile.example.json"), "utf8")
    );
    delete profile.productionProofExecutionPackFile;
    delete profile.productionProofPreflightCommand;
    writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

    const result = runProfileCheck(["--profile-file", profileFile]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.deepEqual(
      output.summary.missingRequiredKeys,
      ["productionProofExecutionPackFile", "productionProofPreflightCommand"]
    );
    assert.match(output.error.message, /missing required profile key/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("staging profile check rejects secret values before real-like rehearsal", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "staging-profile-check-secret-"));
  const profileFile = join(tempRoot, "staging-profile.json");
  try {
    const profile = JSON.parse(
      readFileSync(join(repoRoot, "docs/staging-rehearsal-profile.example.json"), "utf8")
    );
    profile.developerBearerToken = "must-not-be-stored";
    writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

    const result = runProfileCheck(["--profile-file", profileFile]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.deepEqual(output.summary.secretFieldKeys, ["developerBearerToken"]);
    assert.doesNotMatch(result.stdout, /must-not-be-stored/);
    assert.match(output.error.message, /secret values must stay in environment variables/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("staging profile check accepts an older two-argument command and normalizes the next command", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "staging-profile-check-legacy-command-"));
  const profileFile = join(tempRoot, "staging-profile.json");
  try {
    const profile = JSON.parse(
      readFileSync(join(repoRoot, "docs/staging-rehearsal-profile.example.json"), "utf8")
    );
    profile.productionProofPreflightCommand =
      `npm.cmd run launch:production-proof-preflight -- --profile-file ${profileFile}`
      + ` --execution-pack-file ${profile.productionProofExecutionPackFile}`;
    writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

    const result = runProfileCheck(["--profile-file", profileFile]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.summary.legacyProductionProofCommand, true);
    assert.equal(
      output.nextCommand,
      `npm.cmd run launch:production-proof-preflight -- --profile-file ${profileFile}`
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("staging profile check supports --help output", () => {
  const result = spawnSync(process.execPath, ["scripts/staging-profile-check.mjs", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: npm\.cmd run staging:profile:check -- --profile-file <staging-profile\.json>/);
  assert.match(result.stdout, /does not load secrets, write files, or modify live data/i);
});
