import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-deploy-status.mjs");
const defaultTargetDir = "C:\\RockSolidLicense";

function runStatus(args = [], options = {}) {
  return spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function runStatusJson(args = [], options = {}) {
  const result = runStatus(["--json", ...args], options);
  return {
    ...result,
    output: result.stdout ? JSON.parse(result.stdout) : null
  };
}

function writePackFiles(root, keys = ["operator", "first", "evidence"]) {
  const windowsDeployDir = path.join(root, "artifacts", "deploy", "windows");
  mkdirSync(windowsDeployDir, { recursive: true });
  const files = {
    evidence: path.join(windowsDeployDir, "windows-deploy-evidence-pack.md"),
    first: path.join(windowsDeployDir, "windows-first-deploy-pack.md"),
    operator: path.join(windowsDeployDir, "windows-deploy-operator-index.md")
  };
  for (const key of keys) {
    writeFileSync(files[key], `# ${key}\n`, "utf8");
  }
  return files;
}

test("windows deploy status is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:status"], "node scripts/windows-deploy-status.mjs");
});

test("windows deploy status starts with missing local operator pack when no generated packs exist", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-empty-"));
  try {
    const result = runStatusJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "needs_operator_pack");
    assert.equal(result.output.targetDirectory.path, defaultTargetDir);
    assert.equal(result.output.targetDirectory.exists, false);
    assert.equal(result.output.generatedPacks.every((item) => !item.exists), true);
    assert.equal(result.output.operatorHandoff.currentActionKey, "generate_operator_pack");
    assert.equal(result.output.operatorHandoff.nextAction, "npm.cmd run deploy:windows:operator-pack");
    assert.equal(result.output.operatorHandoff.preflightCommand, "npm.cmd run deploy:windows:preflight");
    assert.deepEqual(result.output.summary, {
      willModifyData: false,
      willWriteFiles: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false,
      generatedPackCount: 3,
      missingGeneratedPackCount: 3,
      repositoryAssetCount: 9,
      missingRepositoryAssetCount: 0
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status advances through generated pack prerequisites", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-packs-"));
  try {
    writePackFiles(tempRoot, ["operator"]);
    const firstResult = runStatusJson([], { cwd: tempRoot });
    assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
    assert.equal(firstResult.output.status, "needs_first_deploy_pack");
    assert.equal(firstResult.output.operatorHandoff.nextAction, "npm.cmd run deploy:windows:prepare-pack");

    writePackFiles(tempRoot, ["first"]);
    const evidenceResult = runStatusJson([], { cwd: tempRoot });
    assert.equal(evidenceResult.status, 0, evidenceResult.stderr || evidenceResult.stdout);
    assert.equal(evidenceResult.output.status, "needs_evidence_pack");
    assert.equal(evidenceResult.output.operatorHandoff.nextAction, "npm.cmd run deploy:windows:evidence-pack");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status reports not deployed after generated packs exist but target is missing", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-not-deployed-"));
  try {
    writePackFiles(tempRoot);
    const result = runStatusJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "not_deployed_yet");
    assert.equal(result.output.summary.missingGeneratedPackCount, 0);
    assert.equal(result.output.operatorHandoff.currentActionKey, "place_repository_at_target_directory");
    assert.equal(result.output.operatorHandoff.nextAction, `Place this repository at ${defaultTargetDir}.`);
    assert.equal(result.output.operatorHandoff.preflightCommand, "npm.cmd run deploy:windows:preflight");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status reports env setup and manual start readiness for a staged target", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const envDir = path.join(targetDir, "deploy", "windows");
  const envFile = path.join(envDir, "rocksolid.env.ps1");
  try {
    writePackFiles(tempRoot);
    mkdirSync(envDir, { recursive: true });

    const setupResult = runStatusJson(["--target-dir", targetDir], { cwd: tempRoot });
    assert.equal(setupResult.status, 0, setupResult.stderr || setupResult.stdout);
    assert.equal(setupResult.output.status, "needs_env_setup");
    assert.equal(setupResult.output.targetDirectory.exists, true);
    assert.equal(setupResult.output.targetDirectory.envFileExists, false);
    assert.equal(setupResult.output.operatorHandoff.currentActionKey, "copy_local_env_file");
    assert.match(setupResult.output.operatorHandoff.nextAction, /Copy-Item/);

    writeFileSync(envFile, "# local secrets stay outside generated status\n", "utf8");
    const readyResult = runStatusJson(["--target-dir", targetDir], { cwd: tempRoot });
    assert.equal(readyResult.status, 0, readyResult.stderr || readyResult.stdout);
    assert.equal(readyResult.output.status, "ready_for_manual_start");
    assert.equal(readyResult.output.targetDirectory.envFileExists, true);
    assert.equal(readyResult.output.operatorHandoff.currentActionKey, "run_manual_start");
    assert.match(readyResult.output.operatorHandoff.nextAction, /run-rocksolid\.ps1/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status rejects unknown options and missing values", () => {
  const unknown = runStatus(["--unknown-option"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --unknown-option/);

  const missing = runStatus(["--target-dir", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"--target-dir requires a value\."/);
});

test("windows deploy status fails when required repository assets are missing", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-assets-"));
  const fakeRepo = path.join(tempRoot, "repo");
  try {
    mkdirSync(fakeRepo, { recursive: true });
    const result = runStatusJson(["--repo-root", fakeRepo], { cwd: tempRoot });
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "fail");
    assert.equal(result.output.summary.missingRepositoryAssetCount, 9);
    assert.equal(result.output.operatorHandoff.currentActionKey, "restore_repository_assets");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status plain output prints the current stage and next action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-plain-"));
  try {
    const result = runStatus([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows deploy status: needs_operator_pack/);
    assert.match(result.stdout, /Generated packs: 0\/3/);
    assert.match(result.stdout, /Current action: generate_operator_pack/);
    assert.match(result.stdout, /Next action: npm\.cmd run deploy:windows:operator-pack/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy status supports help output", () => {
  const result = runStatus(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:status -- \[options\]/);
  assert.match(result.stdout, /--target-dir <path>/);
  assert.match(result.stdout, /--repo-root <path>/);
  assert.match(result.stdout, /This command only reads local Windows deployment state\./);
});

test("windows deploy status does not create generated pack files", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-status-no-write-"));
  try {
    const result = runStatusJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(path.join(tempRoot, "artifacts")), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
