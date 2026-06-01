import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProductCode = "FIRSTBATCH";
const defaultChannel = "stable";
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputDir = path.resolve("artifacts", "deploy", "windows");

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value);
}

function parseArgs(argv) {
  const options = {
    channel: defaultChannel,
    help: false,
    json: false,
    outputDir: defaultOutputDir,
    productCode: defaultProductCode,
    repoRoot: path.resolve(__dirname, ".."),
    statusOnly: false,
    targetDir: defaultTargetDir
  };
  const optionMap = {
    "--channel": "channel",
    "--output-dir": "outputDir",
    "--product-code": "productCode",
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
    if (arg === "--status-only") {
      options.statusOnly = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    const key = optionMap[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    options[key] = key === "targetDir" ? value.trim() : path.resolve(value.trim());
    if (key === "productCode" || key === "channel") {
      options[key] = value.trim();
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (!options.productCode) {
    throw new Error("productCode must not be blank.");
  }
  if (!options.channel) {
    throw new Error("channel must not be blank.");
  }
  return options;
}

function isSameOrInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packFiles(outputDir) {
  return {
    evidencePackFile: path.join(outputDir, "windows-deploy-evidence-pack.md"),
    firstDeployPackFile: path.join(outputDir, "windows-first-deploy-pack.md"),
    operatorPackFile: path.join(outputDir, "windows-deploy-operator-index.md")
  };
}

function runNodeScript(scriptName, args) {
  const scriptFile = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.status}`;
    throw new Error(`${scriptName} failed: ${detail.trim()}`);
  }
  return result.stdout;
}

function runJsonScript(scriptName, args) {
  const stdout = runNodeScript(scriptName, ["--json", ...args]);
  return JSON.parse(stdout);
}

function runStatus(options, files) {
  return runJsonScript("windows-deploy-status.mjs", [
    "--target-dir",
    options.targetDir,
    "--repo-root",
    options.repoRoot,
    "--operator-pack-file",
    files.operatorPackFile,
    "--first-deploy-pack-file",
    files.firstDeployPackFile,
    "--evidence-pack-file",
    files.evidencePackFile
  ]);
}

function runPrepareLocal(options) {
  return runJsonScript("windows-deploy-prepare-local.mjs", [
    "--product-code",
    options.productCode,
    "--channel",
    options.channel,
    "--target-dir",
    options.targetDir,
    "--output-dir",
    options.outputDir,
    "--repo-root",
    options.repoRoot
  ]);
}

function statusForLocalStatus(localStatus) {
  if (localStatus.status === "not_deployed_yet") {
    return "ready_for_server_deploy";
  }
  if (localStatus.status === "needs_env_setup") {
    return "server_setup_started_needs_env_setup";
  }
  if (localStatus.status === "ready_for_manual_start") {
    return "server_setup_started_ready_for_manual_start";
  }
  return "not_ready_for_server_deploy";
}

function buildHandoff(status, targetDir, localStatus) {
  if (status === "ready_for_server_deploy") {
    return {
      mode: "windows-server-deploy-gate-handoff/v1",
      currentActionKey: "deploy_repository_to_target_directory",
      readyMessage: `Local preparation is ready to deploy this repository to the Windows server at ${targetDir}.`,
      nextAction: `Deploy this repository to ${targetDir}.`,
      afterDeployCommand: "npm.cmd run deploy:windows:status",
      preflightCommand: "npm.cmd run deploy:windows:preflight"
    };
  }
  if (status === "not_ready_for_server_deploy") {
    return {
      mode: "windows-server-deploy-gate-handoff/v1",
      currentActionKey: "run_local_preparation",
      readyMessage: "Local preparation is not ready for real server deployment yet.",
      nextAction: "npm.cmd run deploy:windows:prepare-local",
      blockingStatus: localStatus.status,
      preflightCommand: "npm.cmd run deploy:windows:preflight"
    };
  }
  return {
    mode: "windows-server-deploy-gate-handoff/v1",
    currentActionKey: localStatus.operatorHandoff.currentActionKey,
    readyMessage: "Server setup appears to have started; continue the server-side deployment sequence.",
    nextAction: localStatus.operatorHandoff.nextAction,
    blockingStatus: localStatus.status,
    preflightCommand: "npm.cmd run deploy:windows:preflight"
  };
}

function buildResult(options) {
  if (isSameOrInside(options.targetDir, options.outputDir)) {
    throw new Error("Generated pack output directory must stay outside the future target directory.");
  }
  const files = packFiles(options.outputDir);
  const localPreparation = options.statusOnly ? null : runPrepareLocal(options);
  const localStatus = options.statusOnly ? runStatus(options, files) : localPreparation.finalStatus;
  const status = statusForLocalStatus(localStatus);
  return {
    status,
    mode: "windows-server-deploy-gate",
    generatedAt: new Date().toISOString(),
    productCode: options.productCode,
    channel: options.channel,
    targetDirectory: options.targetDir,
    outputDirectory: options.outputDir,
    summary: {
      willWriteLocalPacks: !options.statusOnly,
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    },
    localPreparation,
    localStatus,
    deployerHandoff: buildHandoff(status, options.targetDir, localStatus)
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:server-gate -- [options]",
    "",
    "Options:",
    "  --product-code <code>  Product code for artifact paths. Defaults to FIRSTBATCH.",
    "  --channel <name>       Channel for artifact paths. Defaults to stable.",
    "  --target-dir <path>    Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --output-dir <path>    Secret-free local pack output directory.",
    "  --repo-root <path>     Repository root override for diagnostics and tests.",
    "  --status-only          Read status only; do not generate local packs.",
    "  --json                 Print machine-readable JSON.",
    "  --help                 Print this help.",
    "",
    "This command decides whether local preparation is ready for real Windows server deployment."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows server deploy gate: ${result.status}`);
  console.log(`Output directory: ${result.outputDirectory}`);
  console.log(`Local status: ${result.localStatus.status}`);
  console.log(`Ready message: ${result.deployerHandoff.readyMessage}`);
  console.log(`Current action: ${result.deployerHandoff.currentActionKey}`);
  console.log(`Next action: ${result.deployerHandoff.nextAction}`);
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
    if (result.status === "not_ready_for_server_deploy") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-server-deploy-gate",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows server deploy gate failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
