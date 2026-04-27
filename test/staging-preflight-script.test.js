import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runPreflight(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-preflight.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 60_000
  });
}

test("staging preflight is exposed as an npm script and blocks plain-http staging URLs", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:preflight"], "node scripts/staging-preflight.mjs");

  const result = runPreflight([
    "--base-url",
    "http://staging.example.com",
    "--product-code",
    "PILOT_ALPHA",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.equal(output.mode, "staging-preflight");
  assert.match(output.error.message, /requires https:\/\/ staging base URL/);
  assert.equal(output.summary.willWriteLiveData, false);
  assert.equal(output.checks.find((item) => item.name === "base-url.https")?.status, "fail");
});

test("staging preflight returns a redacted launch smoke staging command for valid inputs", () => {
  const result = runPreflight([
    "--base-url",
    "https://staging.example.com/",
    "--product-code",
    "PILOT_ALPHA",
    "--channel",
    "beta",
    "--admin-username",
    "admin@example.com",
    "--admin-password",
    "StrongAdmin123!",
    "--developer-username",
    "launch.smoke.owner",
    "--developer-password",
    "StrongDeveloper123!"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "staging-preflight");
  assert.equal(output.summary.baseUrl, "https://staging.example.com");
  assert.equal(output.summary.productCode, "PILOT_ALPHA");
  assert.equal(output.summary.channel, "beta");
  assert.equal(output.summary.willWriteLiveData, false);
  assert.ok(output.checks.every((item) => item.status === "pass"));
  assert.match(output.nextCommand.powershell, /launch:smoke:staging/);
  assert.match(output.nextCommand.powershell, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
  assert.match(output.nextCommand.powershell, /\$env:RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.doesNotMatch(output.nextCommand.powershell, /StrongAdmin123!/);
  assert.doesNotMatch(output.nextCommand.powershell, /StrongDeveloper123!/);
  assert.equal(output.nextCommand.willWriteLiveData, true);
});
