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
const deploymentBoundary = "read-only status only; do not register Scheduled Tasks, change firewall rules, expose HTTPS, run smoke/full tests, or run backups until manual start and healthcheck pass.";

function defaultPackFiles() {
  const deployDir = path.resolve("artifacts", "deploy", "windows");
  return {
    evidencePackFile: path.join(deployDir, "windows-deploy-evidence-pack.md"),
    firstDeployPackFile: path.join(deployDir, "windows-first-deploy-pack.md"),
    operatorPackFile: path.join(deployDir, "windows-deploy-operator-index.md")
  };
}

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
  const packFiles = defaultPackFiles();
  const options = {
    json: false,
    help: false,
    repoRoot: defaultRepoRoot,
    targetDir: defaultTargetDir,
    ...packFiles
  };
  const optionMap = {
    "--evidence-pack-file": "evidencePackFile",
    "--first-deploy-pack-file": "firstDeployPackFile",
    "--operator-pack-file": "operatorPackFile",
    "--repo-root": "repoRoot",
    "--target-dir": "targetDir"
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
    const key = optionMap[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    options[key] = key === "targetDir" ? value : path.resolve(value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return options;
}

function buildGeneratedPacks(options) {
  return [
    {
      key: "operator_pack",
      command: "npm.cmd run deploy:windows:operator-pack",
      path: options.operatorPackFile,
      exists: existsSync(options.operatorPackFile)
    },
    {
      key: "first_deploy_pack",
      command: "npm.cmd run deploy:windows:prepare-pack",
      path: options.firstDeployPackFile,
      exists: existsSync(options.firstDeployPackFile)
    },
    {
      key: "deploy_evidence_pack",
      command: "npm.cmd run deploy:windows:evidence-pack",
      path: options.evidencePackFile,
      exists: existsSync(options.evidencePackFile)
    }
  ];
}

function buildNextSteps(targetDir) {
  const envExampleFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1.example");
  const envFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const runScript = path.win32.join(targetDir, "deploy", "windows", "run-rocksolid.ps1");
  const healthcheckScript = path.win32.join(targetDir, "deploy", "windows", "healthcheck-rocksolid.ps1");
  return [
    {
      order: 1,
      key: "generate_operator_pack",
      command: "npm.cmd run deploy:windows:operator-pack"
    },
    {
      order: 2,
      key: "generate_first_deploy_pack",
      command: "npm.cmd run deploy:windows:prepare-pack"
    },
    {
      order: 3,
      key: "generate_deploy_evidence_pack",
      command: "npm.cmd run deploy:windows:evidence-pack"
    },
    {
      order: 4,
      key: "run_read_only_preflight",
      command: "npm.cmd run deploy:windows:preflight"
    },
    {
      order: 5,
      key: "place_repository_at_target_directory",
      command: `Place this repository at ${targetDir}.`
    },
    {
      order: 6,
      key: "copy_local_env_file",
      command: `Copy-Item -LiteralPath '${envExampleFile}' -Destination '${envFile}'`
    },
    {
      order: 7,
      key: "replace_local_secrets",
      command: `Edit ${envFile} locally and replace RSL_ADMIN_PASSWORD and RSL_SERVER_TOKEN_SECRET.`
    },
    {
      order: 8,
      key: "run_manual_start",
      command: `powershell -ExecutionPolicy Bypass -File '${runScript}'`
    },
    {
      order: 9,
      key: "run_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${healthcheckScript}'`
    }
  ];
}

function currentActionKeyForStatus(status) {
  return {
    fail: "restore_repository_assets",
    needs_operator_pack: "generate_operator_pack",
    needs_first_deploy_pack: "generate_first_deploy_pack",
    needs_evidence_pack: "generate_deploy_evidence_pack",
    not_deployed_yet: "place_repository_at_target_directory",
    needs_env_setup: "copy_local_env_file",
    ready_for_manual_start: "run_manual_start"
  }[status];
}

function buildOperatorHandoff(status, targetDir) {
  const nextSteps = buildNextSteps(targetDir);
  const currentActionKey = currentActionKeyForStatus(status);
  const currentStep = nextSteps.find((item) => item.key === currentActionKey);
  return {
    mode: "windows-deploy-status-operator-handoff/v1",
    status,
    currentActionKey,
    boundary: deploymentBoundary,
    preflightCommand: "npm.cmd run deploy:windows:preflight",
    nextSteps,
    nextAction: status === "fail"
      ? "Restore missing repository assets or upgrade Node.js before continuing."
      : currentStep?.command || "-"
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
  const generatedPacks = buildGeneratedPacks(options);
  const missingGeneratedPacks = generatedPacks.filter((item) => !item.exists);
  const targetExists = existsSync(options.targetDir);
  const envFile = path.win32.join(options.targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const envFileExists = targetExists && existsSync(envFile);
  const missingPackKey = missingGeneratedPacks[0]?.key;
  const status = !nodeReady || missingRepositoryAssets.length
    ? "fail"
    : missingPackKey === "operator_pack"
      ? "needs_operator_pack"
      : missingPackKey === "first_deploy_pack"
        ? "needs_first_deploy_pack"
        : missingPackKey === "deploy_evidence_pack"
          ? "needs_evidence_pack"
          : !targetExists
            ? "not_deployed_yet"
            : !envFileExists
              ? "needs_env_setup"
              : "ready_for_manual_start";

  return {
    status,
    mode: "windows-deploy-status",
    generatedAt: new Date().toISOString(),
    summary: {
      willModifyData: false,
      willWriteFiles: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false,
      generatedPackCount: generatedPacks.length,
      missingGeneratedPackCount: missingGeneratedPacks.length,
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
    generatedPacks,
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
    "Usage: npm.cmd run deploy:windows:status -- [options]",
    "",
    "Options:",
    "  --target-dir <path>           Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --repo-root <path>            Repository root override for diagnostics and tests.",
    "  --operator-pack-file <path>   Operator index file override.",
    "  --first-deploy-pack-file <path> First deploy pack file override.",
    "  --evidence-pack-file <path>   Deploy evidence pack file override.",
    "  --json                        Print machine-readable JSON.",
    "  --help                        Print this help.",
    "",
    "This command only reads local Windows deployment state."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows deploy status: ${result.status}`);
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
    `Generated packs: ${result.summary.generatedPackCount - result.summary.missingGeneratedPackCount}`
      + `/${result.summary.generatedPackCount}`
  );
  for (const pack of result.generatedPacks.filter((item) => !item.exists)) {
    console.log(`Missing generated pack: ${pack.key} (${pack.path})`);
  }
  console.log(
    `Target install directory: ${result.targetDirectory.path}`
      + ` (exists=${result.targetDirectory.exists ? "yes" : "no"}`
      + `, env=${result.targetDirectory.envFileExists ? "yes" : "no"})`
  );
  console.log(`Current action: ${result.operatorHandoff.currentActionKey}`);
  console.log(`Preflight command: ${result.operatorHandoff.preflightCommand}`);
  console.log(`Deployment boundary: ${result.operatorHandoff.boundary}`);
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
      mode: "windows-deploy-status",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows deploy status failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
