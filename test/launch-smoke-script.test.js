import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createApp } from "../src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

async function startServer(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-launch-smoke-live-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    tcpHost: "127.0.0.1",
    tcpPort: 0,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: "admin",
    adminPassword: "Pass123!abc",
    serverTokenSecret: "launch-smoke-live-test-secret",
    ...overrides
  });

  await app.listen();
  const httpAddress = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${httpAddress.port}`,
    tempDir
  };
}

function spawnNode(args, { timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running node ${args.join(" ")}`));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("launch smoke script runs the first-wave operations preflight", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["launch:smoke"], "node scripts/launch-smoke.mjs");

  const result = spawnSync(
    process.execPath,
    ["scripts/launch-smoke.mjs", "--json", "--product-code", "SMOKE_ALPHA"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 300_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.summary.productCode, "SMOKE_ALPHA");
  assert.equal(output.summary.channel, "stable");
  assert.equal(output.summary.firstWave.inventoryStatus, "ready");
  assert.equal(output.summary.firstWave.firstCardStatus, "ready");
  assert.equal(output.summary.firstWave.confirmationStatus, "confirmed");
  assert.equal(output.summary.firstWave.latestLaunchReceiptOperation, "first_batch_setup");
  assert.equal(output.summary.ops.firstWaveConfirmationStatus, "confirmed");
  assert.ok(output.summary.ops.handoffIndexFileName.endsWith("developer-ops-handoff-index.txt"));
  assert.equal(output.handoff.status, "ready_for_launch_review");
  assert.equal(output.handoff.nextWorkspace.key, "launch-review");
  assert.equal(output.handoff.nextWorkspace.route, "/developer/launch-review?productCode=SMOKE_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave");
  assert.equal(output.handoff.nextWorkspace.href, null);
  assert.equal(output.handoff.reviewWorkspaces.developerOps.route, "/developer/ops?productCode=SMOKE_ALPHA&source=launch-smoke&handoff=first-wave");
  assert.equal(output.handoff.downloads.firstWaveSummary.route, "/api/developer/ops/first-wave/recommendations/download?productCode=SMOKE_ALPHA&channel=stable&limit=20&format=summary");
  assert.equal(output.handoff.downloads.firstWaveChecksums.route, "/api/developer/ops/first-wave/recommendations/download?productCode=SMOKE_ALPHA&channel=stable&limit=20&format=checksums");
  assert.equal(output.handoff.downloads.opsHandoffIndex.route, "/api/developer/ops/export/download?productCode=SMOKE_ALPHA&format=handoff-index&limit=20");
  assert.deepEqual(
    output.handoff.operatorChecklist.map((item) => item.key),
    [
      "open_launch_review",
      "verify_first_wave_confirmation",
      "download_ops_handoff_index",
      "continue_developer_ops_watch"
    ]
  );

  const checkNames = output.checks.map((item) => item.name);
  assert.deepEqual(checkNames, [
    "admin.login",
    "developer.create",
    "product.create",
    "policy.create",
    "developer.login",
    "first-wave.before",
    "first-batches.create",
    "first-wave.after",
    "first-wave.download.summary",
    "first-wave.download.checksums",
    "first-wave.confirm",
    "ops.export",
    "ops.handoff-index"
  ]);
  assert.ok(output.checks.every((item) => item.status === "pass"));
});

test("launch smoke script requires explicit consent before remote live writes", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/launch-smoke.mjs",
      "--json",
      "--base-url",
      "http://127.0.0.1:1",
      "--product-code",
      "LIVE_SMOKE_ALPHA"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 300_000
    }
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.match(output.error.message, /--allow-live-writes/);
});

test("launch smoke script reports missing option values before running checks", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/launch-smoke.mjs", "--json", "--base-url", "--product-code", "LIVE_SMOKE_ALPHA"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 300_000
    }
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.match(output.error.message, /--base-url requires a value/);
  assert.deepEqual(output.checks, []);
});

test("launch smoke script can run the first-wave preflight against an existing API base URL", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const result = await spawnNode(
      [
        "scripts/launch-smoke.mjs",
        "--json",
        "--base-url",
        baseUrl,
        "--allow-live-writes",
        "--admin-username",
        "admin",
        "--admin-password",
        "Pass123!abc",
        "--developer-username",
        "live.smoke.owner",
        "--developer-password",
        "LiveSmokeOwner123!",
        "--product-code",
        "LIVE_SMOKE_ALPHA"
      ]
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.mode, "remote-live-writes");
    assert.equal(output.summary.productCode, "LIVE_SMOKE_ALPHA");
    assert.equal(output.summary.firstWave.inventoryStatus, "ready");
    assert.equal(output.summary.firstWave.confirmationStatus, "confirmed");
    assert.equal(output.summary.ops.firstWaveConfirmationStatus, "confirmed");
    assert.equal(output.handoff.status, "ready_for_launch_review");
    assert.equal(output.handoff.nextWorkspace.href, `${baseUrl}/developer/launch-review?productCode=LIVE_SMOKE_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave`);
    assert.equal(output.handoff.reviewWorkspaces.developerOps.href, `${baseUrl}/developer/ops?productCode=LIVE_SMOKE_ALPHA&source=launch-smoke&handoff=first-wave`);
    assert.equal(output.handoff.downloads.opsHandoffIndex.href, `${baseUrl}/api/developer/ops/export/download?productCode=LIVE_SMOKE_ALPHA&format=handoff-index&limit=20`);
    assert.ok(output.checks.every((item) => item.status === "pass"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
