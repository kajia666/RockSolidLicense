import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-deploy-prepare-local.mjs");
const defaultOutputDir = path.join("artifacts", "deploy", "windows");

function runPrepare(args = [], options = {}) {
  return spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function runPrepareJson(args = [], options = {}) {
  const result = runPrepare(["--json", ...args], options);
  return {
    ...result,
    output: result.stdout ? JSON.parse(result.stdout) : null
  };
}

test("windows deploy prepare local is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:prepare-local"], "node scripts/windows-deploy-prepare-local.mjs");
});

test("windows deploy prepare local generates all three local packs and returns status", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-prepare-local-default-"));
  const outputDir = path.join(tempRoot, defaultOutputDir);
  try {
    const result = runPrepareJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "prepared");
    assert.equal(result.output.finalStatus.status, "not_deployed_yet");
    assert.equal(result.output.finalStatus.operatorHandoff.currentActionKey, "place_repository_at_target_directory");
    assert.equal(result.output.generatedFiles.length, 3);
    assert.equal(existsSync(path.join(outputDir, "windows-deploy-operator-index.md")), true);
    assert.equal(existsSync(path.join(outputDir, "windows-first-deploy-pack.md")), true);
    assert.equal(existsSync(path.join(outputDir, "windows-deploy-evidence-pack.md")), true);
    assert.deepEqual(result.output.summary, {
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    });

    const operatorIndex = readFileSync(path.join(outputDir, "windows-deploy-operator-index.md"), "utf8");
    assert.match(operatorIndex, /npm\.cmd run deploy:windows:status/);
    assert.doesNotMatch(operatorIndex, /ReplaceThisImmediately/);
    assert.doesNotMatch(operatorIndex, /ReplaceThisWithARandomSecret/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy prepare local supports custom product channel target and output directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-prepare-local-custom-"));
  const outputDir = path.join(tempRoot, "handoff");
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  try {
    const result = runPrepareJson([
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
    assert.equal(result.output.productCode, "PILOT_ALPHA");
    assert.equal(result.output.channel, "beta");
    assert.equal(result.output.targetDirectory, targetDir);
    assert.equal(result.output.finalStatus.status, "not_deployed_yet");
    assert.equal(existsSync(targetDir), false);

    const evidencePack = readFileSync(path.join(outputDir, "windows-deploy-evidence-pack.md"), "utf8");
    assert.match(evidencePack, /artifacts\/staging\/PILOT_ALPHA\/beta/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy prepare local refuses to write inside the future target directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-prepare-local-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputDir = path.join(targetDir, "packs");
  try {
    const result = runPrepare(["--target-dir", targetDir, "--output-dir", outputDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay outside the future target directory/);
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy prepare local rejects unknown options missing values and blank channels", () => {
  const unknown = runPrepare(["--unknown-option"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --unknown-option/);

  const missing = runPrepare(["--output-dir", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"--output-dir requires a value\."/);

  const blank = runPrepare(["--json", "--channel", "   "]);
  assert.equal(blank.status, 1);
  assert.match(blank.stdout, /"channel must not be blank\."/);
});

test("windows deploy prepare local plain output prints files final status and next action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-prepare-local-plain-"));
  try {
    const result = runPrepare([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows deploy local preparation: prepared/);
    assert.match(result.stdout, /Generated files: 3/);
    assert.match(result.stdout, /Final status: not_deployed_yet/);
    assert.match(result.stdout, /Next action: Place this repository at C:\\RockSolidLicense\./);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy prepare local supports help output", () => {
  const result = runPrepare(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:prepare-local -- \[options\]/);
  assert.match(result.stdout, /--output-dir <path>/);
  assert.match(result.stdout, /This command only writes local secret-free Windows deployment packs\./);
});
