import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-post-copy-gate.mjs");
const requiredTargetAssets = [
  "package.json",
  "src/server.js",
  "deploy/windows/rocksolid.env.ps1.example",
  "deploy/windows/run-rocksolid.ps1",
  "deploy/windows/healthcheck-rocksolid.ps1",
  "deploy/windows/register-rocksolid-task.ps1",
  "deploy/windows/register-rocksolid-backup-task.ps1",
  "deploy/windows/configure-firewall.ps1",
  "deploy/windows/Caddyfile.example",
  "docs/windows-deployment-guide.md",
  "docs/production-launch-checklist.md"
];

function runGate(args = [], options = {}) {
  return spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function runGateJson(args = [], options = {}) {
  const result = runGate(["--json", ...args], options);
  return {
    ...result,
    output: result.stdout ? JSON.parse(result.stdout) : null
  };
}

function createTargetAssets(targetDir) {
  for (const asset of requiredTargetAssets) {
    const file = path.join(targetDir, asset);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `placeholder for ${asset}\n`, "utf8");
  }
}

test("windows post copy gate is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:post-copy-gate"], "node scripts/windows-post-copy-gate.mjs");
});

test("windows post copy gate waits for the target directory before manual start", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-post-copy-missing-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  try {
    const result = runGateJson(["--target-dir", targetDir]);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "waiting_for_repository_copy");
    assert.equal(result.output.targetDirectory.exists, false);
    assert.equal(result.output.operatorHandoff.currentActionKey, "deploy_repository_to_target_directory");
    assert.equal(result.output.operatorHandoff.nextAction, `Deploy this repository to ${targetDir}.`);
    assert.deepEqual(result.output.summary, {
      willModifyTargetDirectory: false,
      willWriteFiles: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false,
      targetAssetCount: requiredTargetAssets.length,
      missingTargetAssetCount: requiredTargetAssets.length
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows post copy gate blocks manual start when copied target assets are incomplete", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-post-copy-assets-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(path.join(targetDir, "package.json"), "{}", "utf8");
  try {
    const result = runGateJson(["--target-dir", targetDir]);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "target_missing_repository_assets");
    assert.equal(result.output.summary.missingTargetAssetCount, requiredTargetAssets.length - 1);
    assert.equal(result.output.operatorHandoff.currentActionKey, "finish_repository_copy");
    assert.match(result.output.operatorHandoff.nextAction, /Finish copying/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows post copy gate asks for local env setup after repository assets are present", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-post-copy-env-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  try {
    createTargetAssets(targetDir);
    const result = runGateJson(["--target-dir", targetDir]);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "needs_env_setup");
    assert.equal(result.output.targetDirectory.exists, true);
    assert.equal(result.output.targetDirectory.envFileExists, false);
    assert.equal(result.output.operatorHandoff.currentActionKey, "copy_local_env_file");
    assert.match(result.output.operatorHandoff.nextAction, /Copy-Item/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows post copy gate reports ready for manual start after env exists", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-post-copy-ready-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const envFile = path.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  try {
    createTargetAssets(targetDir);
    writeFileSync(envFile, "# local secrets live here\n", "utf8");
    const result = runGateJson(["--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "ready_for_manual_start");
    assert.equal(result.output.targetDirectory.envFileExists, true);
    assert.equal(result.output.operatorHandoff.currentActionKey, "run_manual_start");
    assert.match(result.output.operatorHandoff.nextAction, /run-rocksolid\.ps1/);
    assert.equal(result.output.operatorHandoff.afterStartAction, `powershell -ExecutionPolicy Bypass -File '${path.win32.join(targetDir, "deploy", "windows", "healthcheck-rocksolid.ps1")}'`);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows post copy gate rejects unknown options and missing values", () => {
  const unknown = runGate(["--unknown-option"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --unknown-option/);

  const missing = runGate(["--target-dir", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"--target-dir requires a value\."/);
});

test("windows post copy gate plain output prints status and next action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-post-copy-plain-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  try {
    const result = runGate(["--target-dir", targetDir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Windows post-copy gate: waiting_for_repository_copy/);
    assert.match(result.stdout, /Current action: deploy_repository_to_target_directory/);
    assert.match(result.stdout, /Next action: Deploy this repository to /);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows post copy gate supports help output", () => {
  const result = runGate(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:post-copy-gate -- \[options\]/);
  assert.match(result.stdout, /--target-dir <path>/);
  assert.match(result.stdout, /This command only reads the copied Windows server target state\./);
});
