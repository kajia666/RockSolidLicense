import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const scriptFile = path.join(repoRoot, "scripts", "windows-first-deploy-pack.mjs");
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputRelativePath = path.join("artifacts", "deploy", "windows", "windows-first-deploy-pack.md");

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

test("windows first deploy pack is exposed as an npm script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["deploy:windows:prepare-pack"], "node scripts/windows-first-deploy-pack.mjs");
});

test("windows first deploy pack generates a default secret-free markdown handoff", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-first-pack-default-"));
  const outputFile = path.join(tempRoot, defaultOutputRelativePath);
  try {
    const result = runPackJson([], { cwd: tempRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.status, "prepared");
    assert.equal(result.output.targetDirectory, defaultTargetDir);
    assert.equal(result.output.generatedPackFile, outputFile);
    assert.equal(existsSync(outputFile), true);

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, /# Windows First Deploy Pack/);
    assert.match(markdown, /npm\.cmd run deploy:windows:preflight/);
    assert.match(markdown, /not_deployed_yet/);
    assert.match(markdown, /RSL_ADMIN_PASSWORD/);
    assert.match(markdown, /RSL_SERVER_TOKEN_SECRET/);
    assert.match(markdown, /run-rocksolid\.ps1/);
    assert.match(markdown, /healthcheck-rocksolid\.ps1/);
    assert.match(markdown, /register-rocksolid-task\.ps1/);
    assert.match(markdown, /configure-firewall\.ps1/);
    assert.match(markdown, /register-rocksolid-backup-task\.ps1/);
    assert.match(markdown, /register-rocksolid-postgres-backup-task\.ps1/);
    assert.doesNotMatch(markdown, /ReplaceThisImmediately/);
    assert.doesNotMatch(markdown, /ReplaceThisWithARandomSecret/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows first deploy pack supports a custom future target and output file", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-first-pack-custom-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputFile = path.join(tempRoot, "handoff", "first-deploy.md");
  try {
    const result = runPackJson(["--target-dir", targetDir, "--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.targetDirectory, targetDir);
    assert.equal(result.output.generatedPackFile, outputFile);
    assert.equal(existsSync(outputFile), true);
    assert.equal(existsSync(targetDir), false);

    const markdown = readFileSync(outputFile, "utf8");
    assert.match(markdown, new RegExp(targetDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows first deploy pack reports that generation does not execute deployment actions", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-first-pack-summary-"));
  const outputFile = path.join(tempRoot, "first-deploy.md");
  try {
    const result = runPackJson(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.output.summary, {
      willModifyTargetDirectory: false,
      willCopyFiles: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunBackups: false
    });
    assert.equal(result.output.operatorSteps[0].key, "run_read_only_preflight");
    assert.equal(result.output.operatorSteps[0].command, "npm.cmd run deploy:windows:preflight");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows first deploy pack rejects unknown options", () => {
  const result = runPack(["--unknown-option"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --unknown-option/);
});

test("windows first deploy pack rejects missing output file values", () => {
  const result = runPack(["--output-file", "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"--output-file requires a value\."/);
});

test("windows first deploy pack refuses to write inside the future target directory", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-first-pack-target-"));
  const targetDir = path.join(tempRoot, "FutureRockSolidLicense");
  const outputFile = path.join(targetDir, "windows-first-deploy-pack.md");
  try {
    const result = runPack(["--target-dir", targetDir, "--output-file", outputFile]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay outside the future target directory/);
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows first deploy pack plain output prints the generated file and first safe action", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rsl-windows-first-pack-plain-"));
  const outputFile = path.join(tempRoot, "first-deploy.md");
  try {
    const result = runPack(["--output-file", outputFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Windows first deploy pack: prepared/);
    assert.match(result.stdout, /Generated pack: .*first-deploy\.md/);
    assert.match(result.stdout, /Next action: npm\.cmd run deploy:windows:preflight/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("windows first deploy pack supports help output", () => {
  const result = runPack(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: npm\.cmd run deploy:windows:prepare-pack -- \[options\]/);
  assert.match(result.stdout, /--target-dir <path>/);
  assert.match(result.stdout, /--output-file <path>/);
  assert.match(result.stdout, /This command only writes a secret-free Markdown deployment pack\./);
});
