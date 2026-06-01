import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "..");
const defaultTargetDir = "C:\\RockSolidLicense";
const minimumNodeMajorVersion = 24;
const requiredRepositoryAssets = [
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
const deploymentBoundary = "do not register Scheduled Tasks, change firewall rules, expose HTTPS, or run backups until manual start and healthcheck pass.";

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
    json: false,
    help: false,
    repoRoot: defaultRepoRoot,
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
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (name === "--target-dir") {
      options.targetDir = value;
    } else if (name === "--repo-root") {
      options.repoRoot = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return options;
}

function buildNextSteps(targetDir) {
  const envExampleFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1.example");
  const envFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const runScript = path.win32.join(targetDir, "deploy", "windows", "run-rocksolid.ps1");
  const healthcheckScript = path.win32.join(targetDir, "deploy", "windows", "healthcheck-rocksolid.ps1");
  return [
    {
      order: 1,
      key: "place_repository_at_target_directory",
      command: `Place this repository at ${targetDir}.`
    },
    {
      order: 2,
      key: "copy_local_env_file",
      command: `Copy-Item -LiteralPath '${envExampleFile}' -Destination '${envFile}'`
    },
    {
      order: 3,
      key: "replace_local_secrets",
      command: `Edit ${envFile} locally and replace RSL_ADMIN_PASSWORD and RSL_SERVER_TOKEN_SECRET.`
    },
    {
      order: 4,
      key: "run_manual_start",
      command: `powershell -ExecutionPolicy Bypass -File '${runScript}'`
    },
    {
      order: 5,
      key: "run_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${healthcheckScript}'`
    }
  ];
}

function buildOperatorHandoff(status, targetDir) {
  const nextSteps = buildNextSteps(targetDir);
  const currentActionKey = status === "fail"
    ? "restore_repository_assets"
    : status === "not_deployed_yet"
      ? "place_repository_at_target_directory"
      : status === "needs_env_setup"
        ? "copy_local_env_file"
        : "run_manual_start";
  return {
    mode: "windows-deploy-preflight-operator-handoff/v1",
    status,
    currentActionKey,
    boundary: deploymentBoundary,
    nextSteps,
    nextAction: status === "fail"
      ? "Restore missing repository assets or upgrade Node.js before preparing the Windows target directory."
      : nextSteps.find((item) => item.key === currentActionKey)?.command || "-"
  };
}

function buildResult(options) {
  const nodeMajorVersion = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  const nodeReady = Number.isInteger(nodeMajorVersion) && nodeMajorVersion >= minimumNodeMajorVersion;
  const repositoryAssets = requiredRepositoryAssets.map((assetPath) => ({
    path: assetPath,
    exists: existsSync(path.join(options.repoRoot, assetPath))
  }));
  const missingRepositoryAssets = repositoryAssets.filter((item) => !item.exists);
  const targetExists = existsSync(options.targetDir);
  const envFile = path.win32.join(options.targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const envFileExists = targetExists && existsSync(envFile);
  const status = !nodeReady || missingRepositoryAssets.length
    ? "fail"
    : !targetExists
      ? "not_deployed_yet"
      : !envFileExists
        ? "needs_env_setup"
        : "ready_for_manual_start";

  return {
    status,
    mode: "windows-deploy-preflight",
    generatedAt: new Date().toISOString(),
    summary: {
      willModifyData: false,
      willWriteFiles: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      repositoryAssetCount: repositoryAssets.length,
      missingRepositoryAssetCount: missingRepositoryAssets.length
    },
    node: {
      version: process.version,
      majorVersion: nodeMajorVersion,
      minimumMajorVersion: minimumNodeMajorVersion,
      ready: nodeReady
    },
    repositoryRoot: options.repoRoot,
    repositoryAssets,
    targetDirectory: {
      path: options.targetDir,
      exists: targetExists,
      envFile,
      envFileExists
    },
    operatorHandoff: buildOperatorHandoff(status, options.targetDir)
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:preflight -- [options]",
    "",
    "Options:",
    "  --target-dir <path>  Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --repo-root <path>   Repository root override for diagnostics and tests.",
    "  --json               Print machine-readable JSON.",
    "  --help               Print this help.",
    "",
    "This command only reads deployment preparation state."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows deploy preflight: ${result.status}`);
  console.log(
    `Node.js: ${result.node.version}`
      + ` (major=${result.node.majorVersion}, required>=${result.node.minimumMajorVersion}, ready=${result.node.ready ? "yes" : "no"})`
  );
  console.log(
    `Repository assets: ${result.summary.repositoryAssetCount - result.summary.missingRepositoryAssetCount}`
      + `/${result.summary.repositoryAssetCount}`
  );
  for (const asset of result.repositoryAssets.filter((item) => !item.exists)) {
    console.log(`Missing repository asset: ${asset.path}`);
  }
  console.log(
    `Target install directory: ${result.targetDirectory.path}`
      + ` (exists=${result.targetDirectory.exists ? "yes" : "no"}`
      + `, env=${result.targetDirectory.envFileExists ? "yes" : "no"})`
  );
  console.log(`Current action: ${result.operatorHandoff.currentActionKey}`);
  console.log(`Deployment boundary: ${result.operatorHandoff.boundary}`);
  for (const item of result.operatorHandoff.nextSteps) {
    console.log(`Next step ${item.order}. ${item.key}: ${item.command}`);
  }
  console.log(`Next action: ${result.operatorHandoff.nextAction}`);
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
    if (result.status === "fail") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-deploy-preflight",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows deploy preflight failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
