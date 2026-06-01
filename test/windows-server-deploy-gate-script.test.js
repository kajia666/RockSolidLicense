import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-server-deploy-gate.mjs");
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputDir = path.join("artifacts", "deploy", "windows");

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

function generatedFiles(root) {
  const outputDir = path.join(root, defaultOutputDir);
  return [
    path.join(outputDir, "windows-deploy-operator-index.md"),
    path.join(outputDir, "windows-first-deploy-pack.md"),
    path.join(outputDir, "windows-deploy-evidence-pack.md")
  ];
}

test("windows server deploy gate is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:server-gate"], "node scripts/windows-server-deploy-gate.mjs");
});

test("windows server deploy gate prepares local packs and reports ready for server deploy", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-ready-"));
  try {
    const result = runGateJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "ready_for_server_deploy");
    assert.equal(result.output.localPreparation.status, "prepared");
    assert.equal(result.output.localPreparation.finalStatus.status, "not_deployed_yet");
    assert.equal(result.output.targetDirectory, defaultTargetDir);
    assert.equal(result.output.deployerHandoff.currentActionKey, "deploy_repository_to_target_directory");
    assert.equal(result.output.deployerHandoff.nextAction, `Deploy this repository to ${defaultTargetDir}.`);
    assert.match(result.output.deployerHandoff.readyMessage, /ready to deploy this repository to the Windows server/i);
    assert.deepEqual(result.output.summary, {
      willWriteLocalPacks: true,
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    });
    for (const file of generatedFiles(tempRoot)) {
      assert.equal(existsSync(file), true);
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate supports custom product channel target and output directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-custom-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputDir = path.join(tempRoot, "handoff");
  try {
    const result = runGateJson([
      "--product-code",
      "PILOT_ALPHA",
      "--channel",
      "beta",
      "--target-dir",
      targetDir,
      "--output-dir",
      outputDir
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "ready_for_server_deploy");
    assert.equal(result.output.productCode, "PILOT_ALPHA");
    assert.equal(result.output.channel, "beta");
    assert.equal(result.output.targetDirectory, targetDir);
    assert.equal(result.output.outputDirectory, outputDir);
    assert.equal(existsSync(targetDir), false);

    const evidencePack = readFileSync(path.join(outputDir, "windows-deploy-evidence-pack.md"), "utf8");
    assert.match(evidencePack, /artifacts\/staging\/PILOT_ALPHA\/beta/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate reports server setup has started when target exists", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  mkdirSync(path.join(targetDir, "deploy", "windows"), { recursive: true });
  try {
    const result = runGateJson(["--target-dir", targetDir], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "server_setup_started_needs_env_setup");
    assert.equal(result.output.localPreparation.finalStatus.status, "needs_env_setup");
    assert.equal(result.output.deployerHandoff.currentActionKey, "copy_local_env_file");
    assert.match(result.output.deployerHandoff.nextAction, /Copy-Item/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate status-only mode does not generate missing local packs", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-status-only-"));
  try {
    const result = runGateJson(["--status-only"], { cwd: tempRoot });
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "not_ready_for_server_deploy");
    assert.equal(result.output.localStatus.status, "needs_operator_pack");
    assert.equal(result.output.deployerHandoff.currentActionKey, "run_local_preparation");
    assert.equal(result.output.deployerHandoff.nextAction, "npm.cmd run deploy:windows:prepare-local");
    assert.equal(existsSync(path.join(tempRoot, "artifacts")), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate refuses output inside the future target directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-output-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputDir = path.join(targetDir, "packs");
  try {
    const result = runGate(["--target-dir", targetDir, "--output-dir", outputDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay outside the future target directory/);
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate rejects unknown options missing values and blank product fields", () => {
  const unknown = runGate(["--unknown-option"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --unknown-option/);

  const missing = runGate(["--output-dir", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"--output-dir requires a value\."/);

  const blank = runGate(["--json", "--product-code", "   "]);
  assert.equal(blank.status, 1);
  assert.match(blank.stdout, /"productCode must not be blank\."/);
});

test("windows server deploy gate plain output tells the operator when server deploy can start", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-server-gate-plain-"));
  try {
    const result = runGate([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows server deploy gate: ready_for_server_deploy/);
    assert.match(result.stdout, /Ready message: .*ready to deploy this repository to the Windows server/i);
    assert.match(result.stdout, /Next action: Deploy this repository to C:\\RockSolidLicense\./);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows server deploy gate supports help output", () => {
  const result = runGate(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:server-gate -- \[options\]/);
  assert.match(result.stdout, /--status-only/);
  assert.match(result.stdout, /This command decides whether local preparation is ready for real Windows server deployment\./);
});
