import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputFile = path.resolve("artifacts", "deploy", "windows", "windows-first-deploy-pack.md");

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
    outputFile: defaultOutputFile,
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
    if (name !== "--target-dir" && name !== "--output-file") {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (name === "--target-dir") {
      options.targetDir = value;
    } else {
      options.outputFile = path.resolve(value);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return options;
}

function isSameOrInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildOperatorSteps(targetDir) {
  const envExampleFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1.example");
  const envFile = path.win32.join(targetDir, "deploy", "windows", "rocksolid.env.ps1");
  const windowsScript = (name) => path.win32.join(targetDir, "deploy", "windows", name);
  return [
    {
      order: 1,
      key: "run_read_only_preflight",
      phase: "before_deployment",
      command: "npm.cmd run deploy:windows:preflight"
    },
    {
      order: 2,
      key: "place_repository_at_target_directory",
      phase: "first_server_setup",
      command: `Place this repository at ${targetDir}.`
    },
    {
      order: 3,
      key: "copy_local_env_file",
      phase: "first_server_setup",
      command: `Copy-Item -LiteralPath '${envExampleFile}' -Destination '${envFile}'`
    },
    {
      order: 4,
      key: "replace_local_secrets",
      phase: "first_server_setup",
      command: `Edit ${envFile} locally and replace RSL_ADMIN_PASSWORD and RSL_SERVER_TOKEN_SECRET.`
    },
    {
      order: 5,
      key: "run_manual_start",
      phase: "local_proof",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("run-rocksolid.ps1")}'`
    },
    {
      order: 6,
      key: "run_local_healthcheck",
      phase: "local_proof",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("healthcheck-rocksolid.ps1")}'`
    },
    {
      order: 7,
      key: "register_startup_task_after_healthcheck",
      phase: "after_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("register-rocksolid-task.ps1")}'`
    },
    {
      order: 8,
      key: "configure_firewall_after_healthcheck",
      phase: "after_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("configure-firewall.ps1")}'`
    },
    {
      order: 9,
      key: "register_file_backup_after_healthcheck",
      phase: "after_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("register-rocksolid-backup-task.ps1")}'`
    },
    {
      order: 10,
      key: "register_postgres_backup_if_enabled",
      phase: "after_local_healthcheck",
      command: `powershell -ExecutionPolicy Bypass -File '${windowsScript("register-rocksolid-postgres-backup-task.ps1")}'`
    },
    {
      order: 11,
      key: "configure_https_after_local_proof",
      phase: "after_local_healthcheck",
      command: "Configure Caddy or IIS HTTPS only after manual start and local healthcheck proof pass."
    }
  ];
}

function renderMarkdown(result) {
  const steps = result.operatorSteps
    .map((item) => `${item.order}. \`${item.key}\` (${item.phase})\n\n   \`\`\`powershell\n   ${item.command}\n   \`\`\``)
    .join("\n\n");
  return [
    "# Windows First Deploy Pack",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "## Purpose",
    "",
    `This secret-free handoff prepares the first Windows deployment for \`${result.targetDirectory}\`.`,
    "",
    `\`${result.targetDirectory}\` is the recommended future Windows server installation directory. It is normal for that directory not to exist before deployment starts.`,
    "",
    "## Safety Boundary",
    "",
    "Generating this pack does not modify the future target directory, copy files, start services, register Scheduled Tasks, change firewall rules, configure HTTPS, or execute backups.",
    "",
    "Do not register Scheduled Tasks, change firewall rules, expose HTTPS, or run backups until manual start and local healthcheck pass.",
    "",
    "## Read-only Preflight",
    "",
    "Run this first:",
    "",
    "```powershell",
    "npm.cmd run deploy:windows:preflight",
    "```",
    "",
    "Expected preflight states:",
    "",
    "- `fail`: fix repository assets or Node.js before deployment.",
    "- `not_deployed_yet`: expected before the future target directory exists.",
    "- `needs_env_setup`: target directory exists and local env setup is next.",
    "- `ready_for_manual_start`: local env file exists and manual start is next.",
    "",
    "## Local Environment",
    "",
    `- Example source: \`${path.win32.join(result.targetDirectory, "deploy", "windows", "rocksolid.env.ps1.example")}\``,
    `- Local destination: \`${path.win32.join(result.targetDirectory, "deploy", "windows", "rocksolid.env.ps1")}\``,
    "- Replace these values locally before start: `RSL_ADMIN_PASSWORD`, `RSL_SERVER_TOKEN_SECRET`.",
    "- Never store secret values in this generated pack.",
    "",
    "## Ordered Operator Steps",
    "",
    steps,
    "",
    "## HTTPS Reminder",
    "",
    "Expose HTTPS through Caddy or IIS only after manual start and local healthcheck proof pass. Public traffic stays closed during local proof.",
    ""
  ].join("\n");
}

function buildResult(options) {
  if (isSameOrInside(options.targetDir, options.outputFile)) {
    throw new Error("Generated pack output must stay outside the future target directory.");
  }
  return {
    status: "prepared",
    mode: "windows-first-deploy-pack",
    generatedAt: new Date().toISOString(),
    generatedPackFile: options.outputFile,
    targetDirectory: options.targetDir,
    summary: {
      willModifyTargetDirectory: false,
      willCopyFiles: false,
      willStartService: false,
      willRegisterScheduledTasks: false,
      willChangeFirewall: false,
      willRunBackups: false
    },
    operatorSteps: buildOperatorSteps(options.targetDir)
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:prepare-pack -- [options]",
    "",
    "Options:",
    "  --target-dir <path>   Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --output-file <path>  Secret-free Markdown pack output file.",
    "  --json                Print machine-readable JSON.",
    "  --help                Print this help.",
    "",
    "This command only writes a secret-free Markdown deployment pack."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows first deploy pack: ${result.status}`);
  console.log(`Generated pack: ${result.generatedPackFile}`);
  console.log(`Future target directory: ${result.targetDirectory}`);
  console.log("Deployment boundary: this command does not modify the future target directory or execute deployment actions.");
  console.log(`Next action: ${result.operatorSteps[0].command}`);
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
      mode: "windows-first-deploy-pack",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows first deploy pack failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
