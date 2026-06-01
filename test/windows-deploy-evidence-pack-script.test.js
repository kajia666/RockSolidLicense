import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-deploy-evidence-pack.mjs");
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputRelativePath = path.join("artifacts", "deploy", "windows", "windows-deploy-evidence-pack.md");

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

test("windows deploy evidence pack is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:evidence-pack"], "node scripts/windows-deploy-evidence-pack.mjs");
});

test("windows deploy evidence pack generates a default secret-free markdown handoff", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-evidence-pack-default-"));
  const outputFile = path.join(tempRoot, defaultOutputRelativePath);
  try {
    const result = runPackJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "prepared");
    assert.equal(result.output.productCode, "FIRSTBATCH");
    assert.equal(result.output.channel, "stable");
    assert.equal(result.output.targetDirectory, defaultTargetDir);
    assert.equal(result.output.generatedPackFile, outputFile);
    assert.equal(existsSync(outputFile), true);

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, /# Windows Deploy Evidence Pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:preflight/);
    assert.match(markdown, /npm\.cmd run deploy:windows:prepare-pack/);
    assert.match(markdown, /backup_restore_drill_result/);
    assert.match(markdown, /live_write_smoke_result/);
    assert.match(markdown, /receipt_visibility_review/);
    assert.match(markdown, /full_test_window_passed/);
    assert.match(markdown, /launch_day_watch_summary/);
    assert.match(markdown, /first_wave_closeout/);
    assert.match(markdown, /staging:closeout:backfill/);
    assert.match(markdown, /staging:signoff:backfill/);
    assert.match(markdown, /staging:launch-duty:record/);
    assert.match(markdown, /artifacts\/staging\/FIRSTBATCH\/stable\/filled-closeout-input\.json/);
    assert.match(markdown, /artifacts\/staging\/FIRSTBATCH\/stable\/readiness-action-queue\.md/);
    assert.match(markdown, /artifacts\/staging\/FIRSTBATCH\/stable\/launch-duty-record-index\.json/);
    assert.doesNotMatch(markdown, /ReplaceThisImmediately/);
    assert.doesNotMatch(markdown, /ReplaceThisWithARandomSecret/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy evidence pack supports custom product and channel path rendering", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-evidence-pack-custom-"));
  const outputFile = path.join(tempRoot, "evidence", "pack.md");
  try {
    const result = runPackJson([
      "--product-code",
      "PILOT_ALPHA",
      "--channel",
      "beta",
      "--output-file",
      outputFile
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.productCode, "PILOT_ALPHA");
    assert.equal(result.output.channel, "beta");
    assert.equal(result.output.artifactRoot, "artifacts/staging/PILOT_ALPHA/beta");
    assert.equal(result.output.closeoutInputFile, "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json");

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, /artifacts\/staging\/PILOT_ALPHA\/beta\/backup-restore-drill\.txt/);
    assert.match(markdown, /artifacts\/staging\/PILOT_ALPHA\/beta\/live-write-smoke-output\.json/);
    assert.match(markdown, /artifacts\/staging\/PILOT_ALPHA\/beta\/full-test-output\.txt/);
    assert.match(markdown, /artifacts\/staging\/PILOT_ALPHA\/beta\/first-wave-closeout\.md/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy evidence pack reports no deployment or evidence writes in JSON", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-evidence-pack-json-"));
  const outputFile = path.join(tempRoot, "pack.md");
  try {
    const result = runPackJson(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.output.summary, {
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    });
    assert.equal(result.output.nextAction, "npm.cmd run deploy:windows:preflight");
    assert.ok(result.output.evidenceGroups.some((item) => item.key === "closeout_backfill"));
    assert.ok(result.output.evidenceGroups.some((item) => item.key === "production_signoff"));
    assert.ok(result.output.evidenceGroups.some((item) => item.key === "launch_duty_records"));
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy evidence pack rejects unknown options", () => {
  const result = runPack(["--unknown-option"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --unknown-option/);
});

test("windows deploy evidence pack rejects missing product code values", () => {
  const result = runPack(["--product-code", "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"--product-code requires a value\."/);
});

test("windows deploy evidence pack rejects blank channels", () => {
  const result = runPack(["--json", "--channel", "   "]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"channel must not be blank\."/);
});

test("windows deploy evidence pack refuses to write inside the future target directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-evidence-pack-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputFile = path.join(targetDir, "windows-deploy-evidence-pack.md");
  try {
    const result = runPack(["--target-dir", targetDir, "--output-file", outputFile]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay outside the future target directory/);
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy evidence pack plain output prints the generated file and first safe action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-evidence-pack-plain-"));
  const outputFile = path.join(tempRoot, "evidence-pack.md");
  try {
    const result = runPack(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows deploy evidence pack: prepared/);
    assert.match(result.stdout, /Generated pack: .*evidence-pack\.md/);
    assert.match(result.stdout, /Evidence groups: /);
    assert.match(result.stdout, /Next action: npm\.cmd run deploy:windows:preflight/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows deploy evidence pack supports help output", () => {
  const result = runPack(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:evidence-pack -- \[options\]/);
  assert.match(result.stdout, /--product-code <code>/);
  assert.match(result.stdout, /--channel <name>/);
  assert.match(result.stdout, /--output-file <path>/);
  assert.match(result.stdout, /This command only writes a secret-free evidence handoff pack\./);
});
