import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

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
