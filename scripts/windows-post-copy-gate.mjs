import { existsSync } from "node:fs";
import path from "node:path";

const defaultTargetDir = "C:\\RockSolidLicense";
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
const boundary = "read-only post-copy gate; do not start services, register Scheduled Tasks, change firewall rules, expose HTTPS, run smoke/full tests, or run backups from this command.";

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value).trim();
}

function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    targetDir: defaultTargetDir
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    if (name !== "--target-dir") {
      throw new Error(`Unknown option: ${name}`);
    }
    options.targetDir = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return options;
}

function buildTargetAssets(targetDir) {
  return requiredTargetAssets.map((assetPath) => ({
    path: assetPath,
    fullPath: path.join(targetDir, assetPath),
    exists: existsSync(path.join(targetDir, assetPath))
  }));
}

function buildOperatorHandoff(status, targetDir) {
  const envExampleFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1.example");
  const envFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const runScript = path.win32.join(targetDir, "deploy", "windows", "run-rocksolid.ps1");
  const healthcheckScript = path.win32.join(targetDir, "deploy", "windows", "healthcheck-rocksolid.ps1");

  if (status === "waiting_for_repository_copy") {
    return {
      mode: "windows-post-copy-gate-handoff/v1",
      currentActionKey: "deploy_repository_to_target_directory",
      boundary,
      nextAction: `Deploy this repository to ${targetDir}.`,
      afterAction: "npm.cmd run deploy:windows:post-copy-gate"
    };
  }
  if (status === "target_missing_repository_assets") {
    return {
      mode: "windows-post-copy-gate-handoff/v1",
      currentActionKey: "finish_repository_copy",
      boundary,
      nextAction: `Finish copying this repository to ${targetDir}, then run npm.cmd run deploy:windows:post-copy-gate again.`,
      afterAction: "npm.cmd run deploy:windows:post-copy-gate"
    };
  }
  if (status === "needs_env_setup") {
    return {
      mode: "windows-post-copy-gate-handoff/v1",
      currentActionKey: "copy_local_env_file",
      boundary,
      nextAction: `Copy-Item -LiteralPath '${envExampleFile}' -Destination '${envFile}'`,
      afterAction: `Edit ${envFile} locally and replace RSL_ADMIN_PASSWORD and RSL_SERVER_TOKEN_SECRET.`
    };
  }
  return {
    mode: "windows-post-copy-gate-handoff/v1",
    currentActionKey: "run_manual_start",
    boundary,
    nextAction: `powershell -ExecutionPolicy Bypass -File '${runScript}'`,
    afterStartAction: `powershell -ExecutionPolicy Bypass -File '${healthcheckScript}'`
  };
}

function buildResult(options) {
  const targetExists = existsSync(options.targetDir);
  const targetAssets = buildTargetAssets(options.targetDir);
  const missingTargetAssets = targetAssets.filter((item) => !item.exists);
  const envFile = path.win32.join(options.targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const envFileExists = targetExists && existsSync(envFile);
  const status = !targetExists
    ? "waiting_for_repository_copy"
    : missingTargetAssets.length
      ? "target_missing_repository_assets"
      : !envFileExists
        ? "needs_env_setup"
        : "ready_for_manual_start";

  return {
    status,
    mode: "windows-post-copy-gate",
    generatedAt: new Date().toISOString(),
    summary: {
      willModifyTargetDirectory: false,
      willWriteFiles: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false,
      targetAssetCount: targetAssets.length,
      missingTargetAssetCount: missingTargetAssets.length
    },
    targetDirectory: {
      path: options.targetDir,
      exists: targetExists,
      envFile,
      envFileExists
    },
    targetAssets,
    operatorHandoff: buildOperatorHandoff(status, options.targetDir)
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:post-copy-gate -- [options]",
    "",
    "Options:",
    "  --target-dir <path>  Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --json               Print machine-readable JSON.",
    "  --help               Print this help.",
    "",
    "This command only reads the copied Windows server target state."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows post-copy gate: ${result.status}`);
  console.log(
    `Target install directory: ${result.targetDirectory.path}`
      + ` (exists=${result.targetDirectory.exists ? "yes" : "no"}`
      + `, env=${result.targetDirectory.envFileExists ? "yes" : "no"})`
  );
  console.log(
    `Target assets: ${result.summary.targetAssetCount - result.summary.missingTargetAssetCount}`
      + `/${result.summary.targetAssetCount}`
  );
  for (const asset of result.targetAssets.filter((item) => !item.exists)) {
    console.log(`Missing target asset: ${asset.path}`);
  }
  console.log(`Current action: ${result.operatorHandoff.currentActionKey}`);
  console.log(`Deployment boundary: ${result.operatorHandoff.boundary}`);
  console.log(`Next action: ${result.operatorHandoff.nextAction}`);
  if (result.operatorHandoff.afterStartAction) {
    console.log(`After start action: ${result.operatorHandoff.afterStartAction}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    if (options.help) {
      writeHelp();
      return;
    }
    const result = buildResult(options);
    writeResult(result, json);
    if (result.status !== "ready_for_manual_start") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-post-copy-gate",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows post-copy gate failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
