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

function buildPreparationCommands(options, files) {
  return [
    {
      key: "operator_pack",
      command: "npm.cmd run deploy:windows:operator-pack",
      script: "windows-deploy-operator-pack.mjs",
      args: [
        "--product-code",
        options.productCode,
        "--channel",
        options.channel,
        "--target-dir",
        options.targetDir,
        "--output-file",
        files.operatorPackFile
      ],
      outputFile: files.operatorPackFile
    },
    {
      key: "first_deploy_pack",
      command: "npm.cmd run deploy:windows:prepare-pack",
      script: "windows-first-deploy-pack.mjs",
      args: [
        "--target-dir",
        options.targetDir,
        "--output-file",
        files.firstDeployPackFile
      ],
      outputFile: files.firstDeployPackFile
    },
    {
      key: "deploy_evidence_pack",
      command: "npm.cmd run deploy:windows:evidence-pack",
      script: "windows-deploy-evidence-pack.mjs",
      args: [
        "--product-code",
        options.productCode,
        "--channel",
        options.channel,
        "--target-dir",
        options.targetDir,
        "--output-file",
        files.evidencePackFile
      ],
      outputFile: files.evidencePackFile
    }
  ];
}

function buildResult(options) {
  if (isSameOrInside(options.targetDir, options.outputDir)) {
    throw new Error("Generated pack output directory must stay outside the future target directory.");
  }
  const files = packFiles(options.outputDir);
  const commands = buildPreparationCommands(options, files);
  for (const item of commands) {
    runJsonScript(item.script, item.args);
  }
  const finalStatus = runJsonScript("windows-deploy-status.mjs", [
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
  return {
    status: "prepared",
    mode: "windows-deploy-prepare-local",
    generatedAt: new Date().toISOString(),
    productCode: options.productCode,
    channel: options.channel,
    targetDirectory: options.targetDir,
    outputDirectory: options.outputDir,
    generatedFiles: commands.map((item) => ({
      key: item.key,
      command: item.command,
      path: item.outputFile
    })),
    summary: {
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    },
    finalStatus
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:prepare-local -- [options]",
    "",
    "Options:",
    "  --product-code <code>  Product code for artifact paths. Defaults to FIRSTBATCH.",
    "  --channel <name>       Channel for artifact paths. Defaults to stable.",
    "  --target-dir <path>    Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --output-dir <path>    Secret-free local pack output directory.",
    "  --repo-root <path>     Repository root override for diagnostics and tests.",
    "  --json                 Print machine-readable JSON.",
    "  --help                 Print this help.",
    "",
    "This command only writes local secret-free Windows deployment packs."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows deploy local preparation: ${result.status}`);
  console.log(`Output directory: ${result.outputDirectory}`);
  console.log(`Generated files: ${result.generatedFiles.length}`);
  for (const item of result.generatedFiles) {
    console.log(`Generated ${item.key}: ${item.path}`);
  }
  console.log(`Final status: ${result.finalStatus.status}`);
  console.log(`Current action: ${result.finalStatus.operatorHandoff.currentActionKey}`);
  console.log(`Next action: ${result.finalStatus.operatorHandoff.nextAction}`);
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
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-deploy-prepare-local",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows deploy local preparation failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
