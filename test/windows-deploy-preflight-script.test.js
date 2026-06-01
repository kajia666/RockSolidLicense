import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const defaultTargetDir = "C:\\RockSolidLicense";

function runPreflight(args = [], options = {}) {
  return spawnSync(process.execPath, ["scripts/windows-deploy-preflight.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function runPreflightJson(args = []) {
  const result = runPreflight(["--json", ...args]);
  return {
    ...result,
    output: result.stdout ? JSON.parse(result.stdout) : null
  };
}

test("windows deploy preflight is exposed as an npm script and reports the default target directory", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:preflight"], "node scripts/windows-deploy-preflight.mjs");

  const result = runPreflightJson();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.output.targetDirectory.path, defaultTargetDir);
  assert.equal(result.output.targetDirectory.exists, existsSync(defaultTargetDir));
});

test("windows deploy preflight treats a missing target directory as an informational undeployed state", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-deploy-missing-"));
  const targetDir = path.join(tempRoot, "RockSolidLicense");
  try {
    const result = runPreflightJson(["--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "not_deployed_yet");
    assert.equal(result.output.summary.willModifyData, false);
    assert.equal(result.output.summary.willWriteFiles, false);
    assert.equal(result.output.summary.willStartService, false);
    assert.equal(result.output.summary.willRegisterScheduledTasks, false);
    assert.equal(result.output.summary.willChangeFirewall, false);
    assert.equal(result.output.targetDirectory.exists, false);
    assert.equal(existsSync(targetDir), false);
    assert.equal(result.output.operatorHandoff.currentActionKey, "place_repository_at_target_directory");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy preflight reports env setup after the target directory exists", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-deploy-env-"));
  const targetDir = path.join(tempRoot, "RockSolidLicense");
  mkdirSync(targetDir, { recursive: true });
  try {
    const result = runPreflightJson(["--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "needs_env_setup");
    assert.equal(result.output.targetDirectory.exists, true);
    assert.equal(result.output.targetDirectory.envFileExists, false);
    assert.equal(result.output.operatorHandoff.currentActionKey, "copy_local_env_file");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy preflight reports manual start readiness after the local env file exists", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-deploy-ready-"));
  const targetDir = path.join(tempRoot, "RockSolidLicense");
  const envFile = path.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, "$env:NODE_ENV = \"production\"\n", "utf8");
  try {
    const result = runPreflightJson(["--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "ready_for_manual_start");
    assert.equal(result.output.targetDirectory.envFileExists, true);
    assert.equal(result.output.operatorHandoff.currentActionKey, "run_manual_start");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy preflight fails when a required repository asset is missing", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-deploy-repo-"));
  try {
    const result = runPreflightJson(["--repo-root", tempRoot, "--target-dir", path.join(tempRoot, "target")]);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "fail");
    assert.ok(result.output.repositoryAssets.some((item) => item.exists === false));
    assert.equal(result.output.operatorHandoff.currentActionKey, "restore_repository_assets");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy preflight plain output prints the safe boundary and next actions", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-deploy-plain-"));
  const targetDir = path.join(tempRoot, "RockSolidLicense");
  try {
    const result = runPreflight(["--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows deploy preflight: not_deployed_yet/);
    assert.match(result.stdout, /Target install directory: .*RockSolidLicense \(exists=no, env=no\)/);
    assert.match(result.stdout, /Current action: place_repository_at_target_directory/);
    assert.match(result.stdout, /Deployment boundary: do not register Scheduled Tasks, change firewall rules, expose HTTPS, or run backups until manual start and healthcheck pass\./);
    assert.match(result.stdout, /Next step 1\. place_repository_at_target_directory:/);
    assert.match(result.stdout, /Next step 5\. run_local_healthcheck:/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy preflight supports help output", () => {
  const result = runPreflight(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:preflight -- \[options\]/);
  assert.match(result.stdout, /--target-dir <path>/);
  assert.match(result.stdout, /--repo-root <path>/);
  assert.match(result.stdout, /This command only reads deployment preparation state\./);
});

