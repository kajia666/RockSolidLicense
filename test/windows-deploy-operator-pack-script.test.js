import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-deploy-operator-pack.mjs");
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputRelativePath = path.join("artifacts", "deploy", "windows", "windows-deploy-operator-index.md");

function runPack(args = [], options = {}) {
  return spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function runPackJson(args = [], options = {}) {
  const result = runPack(["--json", ...args], options);
  return {
    ...result,
    output: result.stdout ? JSON.parse(result.stdout) : null
  };
}

test("windows deploy operator pack is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:operator-pack"], "node scripts/windows-deploy-operator-pack.mjs");
});

test("windows deploy operator pack generates a default secret-free operator index", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-operator-pack-default-"));
  const outputFile = path.join(tempRoot, defaultOutputRelativePath);
  try {
    const result = runPackJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "prepared");
    assert.equal(result.output.productCode, "FIRSTBATCH");
    assert.equal(result.output.channel, "stable");
    assert.equal(result.output.targetDirectory, defaultTargetDir);
    assert.equal(result.output.generatedPackFile, outputFile);
    assert.equal(result.output.firstDeployPackFile, path.join(tempRoot, "artifacts", "deploy", "windows", "windows-first-deploy-pack.md"));
    assert.equal(result.output.evidencePackFile, path.join(tempRoot, "artifacts", "deploy", "windows", "windows-deploy-evidence-pack.md"));
    assert.equal(existsSync(outputFile), true);

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, /# Windows Deploy Operator Pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:prepare-local/);
    assert.match(markdown, /npm\.cmd run deploy:windows:operator-pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:status/);
    assert.match(markdown, /npm\.cmd run deploy:windows:prepare-pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:evidence-pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:preflight/);
    assert.match(markdown, /windows-first-deploy-pack\.md/);
    assert.match(markdown, /windows-deploy-evidence-pack\.md/);
    assert.match(markdown, /windows-deploy-operator-index\.md/);
    assert.match(markdown, /not_deployed_yet/);
    assert.match(markdown, /ready_for_manual_start/);
    assert.match(markdown, /backup_restore_drill_result/);
    assert.match(markdown, /live_write_smoke_result/);
    assert.match(markdown, /full_test_window_passed/);
    assert.match(markdown, /launch_day_watch_summary/);
    assert.doesNotMatch(markdown, /ReplaceThisImmediately/);
    assert.doesNotMatch(markdown, /ReplaceThisWithARandomSecret/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy operator pack supports custom product channel target and output file", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-operator-pack-custom-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputFile = path.join(tempRoot, "handoff", "operator-index.md");
  try {
    const result = runPackJson([
      "--product-code",
      "PILOT_ALPHA",
      "--channel",
      "beta",
      "--target-dir",
      targetDir,
      "--output-file",
      outputFile
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.productCode, "PILOT_ALPHA");
    assert.equal(result.output.channel, "beta");
    assert.equal(result.output.targetDirectory, targetDir);
    assert.equal(result.output.generatedPackFile, outputFile);
    assert.equal(result.output.artifactRoot, "artifacts/staging/PILOT_ALPHA/beta");
    assert.equal(existsSync(outputFile), true);
    assert.equal(existsSync(targetDir), false);

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, /PILOT_ALPHA/);
    assert.match(markdown, /beta/);
    assert.match(markdown, /artifacts\/staging\/PILOT_ALPHA\/beta/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy operator pack reports safe non-execution boundaries", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-operator-pack-summary-"));
  const outputFile = path.join(tempRoot, "operator-index.md");
  try {
    const result = runPackJson(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
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
    assert.equal(result.output.nextAction, "npm.cmd run deploy:windows:prepare-pack");
    assert.deepEqual(result.output.commandSequence.map((item) => item.key), [
      "generate_first_deploy_pack",
      "generate_deploy_evidence_pack",
      "run_read_only_preflight",
      "review_operator_index",
      "review_first_deploy_pack",
      "review_evidence_pack"
    ]);
    assert.equal(result.output.commandSequence[2].expectedState, "not_deployed_yet or ready_for_manual_start");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy operator pack rejects unknown options", () => {
  const result = runPack(["--unknown-option"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --unknown-option/);
});

test("windows deploy operator pack rejects missing product code values", () => {
  const result = runPack(["--product-code", "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"--product-code requires a value\."/);
});

test("windows deploy operator pack rejects blank channels", () => {
  const result = runPack(["--json", "--channel", "   "]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"channel must not be blank\."/);
});

test("windows deploy operator pack refuses to write inside the future target directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-operator-pack-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputFile = path.join(targetDir, "windows-deploy-operator-index.md");
  try {
    const result = runPack(["--target-dir", targetDir, "--output-file", outputFile]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay outside the future target directory/);
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy operator pack plain output prints generated file and next safe action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-operator-pack-plain-"));
  const outputFile = path.join(tempRoot, "operator-index.md");
  try {
    const result = runPack(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows deploy operator pack: prepared/);
    assert.match(result.stdout, /Generated pack: .*operator-index\.md/);
    assert.match(result.stdout, /Next action: npm\.cmd run deploy:windows:prepare-pack/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy operator pack supports help output", () => {
  const result = runPack(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:operator-pack -- \[options\]/);
  assert.match(result.stdout, /--product-code <code>/);
  assert.match(result.stdout, /--channel <name>/);
  assert.match(result.stdout, /--output-file <path>/);
  assert.match(result.stdout, /This command only writes a secret-free Windows deployment operator index\./);
});
