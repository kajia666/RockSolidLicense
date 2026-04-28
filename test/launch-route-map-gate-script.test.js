import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

test("launch route map gate is exposed as a reusable targeted verification script", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["launch:route-map-gate"], "node scripts/launch-route-map-gate.mjs");

  const result = spawnSync(process.execPath, ["scripts/launch-route-map-gate.mjs", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "launch-route-map-gate");
  assert.equal(output.dryRun, true);
  assert.equal(output.summary.willRunFullSuite, false);
  assert.deepEqual(
    output.commands.map((command) => command.key),
    [
      "launch_mainline_action_visibility",
      "developer_ops_export_and_mainline_action",
      "launch_smoke_script",
      "staging_rehearsal_script",
      "services_syntax_check",
      "diff_whitespace_check"
    ]
  );

  const licenseFlowCommand = output.commands.find(
    (command) => command.key === "developer_ops_export_and_mainline_action"
  );
  assert.ok(licenseFlowCommand);
  assert.ok(licenseFlowCommand.args.includes("--test-name-pattern"));
  assert.match(
    licenseFlowCommand.args[licenseFlowCommand.args.indexOf("--test-name-pattern") + 1],
    /developer ops export bundles scoped data and downloadable assets/
  );
  assert.match(
    licenseFlowCommand.args[licenseFlowCommand.args.indexOf("--test-name-pattern") + 1],
    /developer launch mainline action can record a first-wave ops sweep/
  );
});
