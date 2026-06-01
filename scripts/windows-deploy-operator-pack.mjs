import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultProductCode = "FIRSTBATCH";
const defaultChannel = "stable";
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputFile = path.resolve("artifacts", "deploy", "windows", "windows-deploy-operator-index.md");
const defaultFirstDeployPackFile = path.resolve("artifacts", "deploy", "windows", "windows-first-deploy-pack.md");
const defaultEvidencePackFile = path.resolve("artifacts", "deploy", "windows", "windows-deploy-evidence-pack.md");

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
    outputFile: defaultOutputFile,
    productCode: defaultProductCode,
    targetDir: defaultTargetDir
  };
  const optionMap = {
    "--channel": "channel",
    "--output-file": "outputFile",
    "--product-code": "productCode",
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
    options[key] = key === "outputFile" ? path.resolve(value.trim()) : value.trim();
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

function artifactRoot(productCode, channel) {
  return `artifacts/staging/${productCode}/${channel}`;
}

function buildCommandSequence(result) {
  return [
    {
      order: 1,
      key: "generate_first_deploy_pack",
      phase: "before_server_exists",
      command: "npm.cmd run deploy:windows:prepare-pack",
      outputFile: result.firstDeployPackFile,
      expectedState: "secret-free markdown handoff generated"
    },
    {
      order: 2,
      key: "generate_deploy_evidence_pack",
      phase: "before_server_exists",
      command: "npm.cmd run deploy:windows:evidence-pack",
      outputFile: result.evidencePackFile,
      expectedState: "secret-free deployment-day evidence guide generated"
    },
    {
      order: 3,
      key: "run_read_only_preflight",
      phase: "before_or_after_repo_copy",
      command: "npm.cmd run deploy:windows:preflight",
      outputFile: null,
      expectedState: "not_deployed_yet or ready_for_manual_start"
    },
    {
      order: 4,
      key: "review_operator_index",
      phase: "operator_review",
      command: `Review ${result.generatedPackFile}`,
      outputFile: result.generatedPackFile,
      expectedState: "operator knows the next safe command"
    },
    {
      order: 5,
      key: "review_first_deploy_pack",
      phase: "operator_review",
      command: `Review ${result.firstDeployPackFile}`,
      outputFile: result.firstDeployPackFile,
      expectedState: "manual start and local healthcheck order is clear"
    },
    {
      order: 6,
      key: "review_evidence_pack",
      phase: "operator_review",
      command: `Review ${result.evidencePackFile}`,
      outputFile: result.evidencePackFile,
      expectedState: "deployment-day evidence capture order is clear"
    }
  ];
}

function renderMarkdown(result) {
  const commandRows = result.commandSequence.map((item) => [
    `## ${item.order}. ${item.key}`,
    "",
    `Phase: \`${item.phase}\``,
    "",
    `Expected state: \`${item.expectedState}\``,
    "",
    item.outputFile ? `Output/review file: \`${item.outputFile}\`` : "Output/review file: -",
    "",
    "```powershell",
    item.command,
    "```"
  ].join("\n")).join("\n\n");

  return [
    "# Windows Deploy Operator Pack",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    `Product: ${result.productCode}`,
    `Channel: ${result.channel}`,
    `Future Windows target: ${result.targetDirectory}`,
    `Artifact root: ${result.artifactRoot}`,
    "",
    "## Purpose",
    "",
    "This secret-free index is the first Windows deployment operator entrypoint. It tells the operator which local packs to generate, which read-only preflight to run, and which generated handoff file to review next.",
    "",
    "Run this index generator again whenever the repository changes before first deployment:",
    "",
    "```powershell",
    "npm.cmd run deploy:windows:operator-pack",
    "```",
    "",
    "Check the current local deployment state at any time:",
    "",
    "```powershell",
    "npm.cmd run deploy:windows:status",
    "```",
    "",
    "## Safety Boundary",
    "",
    `Generating this index writes only \`${result.generatedPackFile}\`. It does not modify \`${result.targetDirectory}\`, call backend APIs, start services, register Scheduled Tasks, change firewall rules, run smoke tests, run full tests, or write launch evidence.`,
    "",
    `\`${result.targetDirectory}\` is the recommended future Windows server installation directory. It is normal for that directory not to exist before deployment starts; in that state, preflight should report \`not_deployed_yet\`. After the repository and local env file are in place, preflight should move toward \`ready_for_manual_start\`.`,
    "",
    "## Generated Pack Files",
    "",
    `- Operator index: \`${result.generatedPackFile}\``,
    `- First deploy pack: \`${result.firstDeployPackFile}\``,
    `- Deploy evidence pack: \`${result.evidencePackFile}\``,
    "",
    "## Command Sequence",
    "",
    commandRows,
    "",
    "## Deployment-Day Evidence Anchors",
    "",
    `Use \`${result.evidencePackFile}\` after manual start, local healthcheck, HTTPS, and required secret configuration. It keeps these evidence anchors together without writing evidence automatically:`,
    "",
    "- `backup_restore_drill_result`",
    "- `live_write_smoke_result`",
    "- `full_test_window_passed`",
    "- `launch_day_watch_summary`",
    "",
    "## Next Action",
    "",
    "```powershell",
    result.nextAction,
    "```",
    ""
  ].join("\n");
}

function buildResult(options) {
  if (isSameOrInside(options.targetDir, options.outputFile)) {
    throw new Error("Generated pack output must stay outside the future target directory.");
  }
  const result = {
    status: "prepared",
    mode: "windows-deploy-operator-pack",
    generatedAt: new Date().toISOString(),
    generatedPackFile: options.outputFile,
    firstDeployPackFile: defaultFirstDeployPackFile,
    evidencePackFile: defaultEvidencePackFile,
    productCode: options.productCode,
    channel: options.channel,
    targetDirectory: options.targetDir,
    artifactRoot: artifactRoot(options.productCode, options.channel),
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
    nextAction: "npm.cmd run deploy:windows:prepare-pack"
  };
  return {
    ...result,
    commandSequence: buildCommandSequence(result)
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:operator-pack -- [options]",
    "",
    "Options:",
    "  --product-code <code>  Product code for artifact paths. Defaults to FIRSTBATCH.",
    "  --channel <name>       Channel for artifact paths. Defaults to stable.",
    "  --target-dir <path>    Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --output-file <path>   Secret-free Markdown operator index output file.",
    "  --json                 Print machine-readable JSON.",
    "  --help                 Print this help.",
    "",
    "This command only writes a secret-free Windows deployment operator index."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows deploy operator pack: ${result.status}`);
  console.log(`Generated pack: ${result.generatedPackFile}`);
  console.log(`Product/channel: ${result.productCode}/${result.channel}`);
  console.log(`Future target directory: ${result.targetDirectory}`);
  console.log(`Command sequence: ${result.commandSequence.map((item) => item.key).join(" -> ")}`);
  console.log(`Next action: ${result.nextAction}`);
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
    mkdirSync(path.dirname(result.generatedPackFile), { recursive: true });
    writeFileSync(result.generatedPackFile, renderMarkdown(result), "utf8");
    writeResult(result, json);
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-deploy-operator-pack",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows deploy operator pack failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
